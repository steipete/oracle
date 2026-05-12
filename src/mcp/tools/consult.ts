import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCliVersion } from "../../version.js";
import { LoggingMessageNotificationParamsSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensureBrowserAvailable, mapConsultToRunOptions } from "../utils.js";
import type { BrowserSessionConfig, SessionModelRun } from "../../sessionStore.js";
import { sessionStore } from "../../sessionStore.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import { createRemoteBrowserExecutor } from "../../remote/client.js";
import type { BrowserSessionRunnerDeps } from "../../browser/sessionRunner.js";

async function readSessionLogTail(sessionId: string, maxBytes: number): Promise<string | null> {
  try {
    const log = await sessionStore.readLog(sessionId);
    if (log.length <= maxBytes) {
      return log;
    }
    return log.slice(-maxBytes);
  } catch {
    return null;
  }
}
import { performSessionRun } from "../../cli/sessionRunner.js";
import { runDryRunSummary } from "../../cli/dryRun.js";
import { CHATGPT_URL } from "../../browser/constants.js";
import { CONSULT_PRESETS, consultInputSchema } from "../types.js";
import { applyConsultPreset } from "../consultPresets.js";
import { loadUserConfig, type UserConfig } from "../../config.js";
import { resolveNotificationSettings } from "../../cli/notifier.js";
import { mapModelToBrowserLabel, resolveBrowserModelLabel } from "../../cli/browserConfig.js";
import type { BrowserModelStrategy } from "../../browser/types.js";

// Use raw shapes so the MCP SDK (with its bundled Zod) wraps them and emits valid JSON Schema.
const consultInputShape = {
  preset: z
    .enum(CONSULT_PRESETS)
    .optional()
    .describe(
      'Optional MCP convenience preset. "chatgpt-pro-heavy" selects ChatGPT browser mode, the current Pro model alias, and Pro Extended thinking unless overridden.',
    ),
  prompt: z.string().min(1, "Prompt is required.").describe("User prompt to run."),
  files: z
    .array(z.string())
    .default([])
    .describe(
      "Optional file paths or glob patterns (like the CLI `--file`). Resolved relative to the MCP server working directory.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Single model name/label. If `engine` is omitted, Oracle follows CLI defaults: config/ORACLE_ENGINE first, then `api` when OPENAI_API_KEY is set, otherwise `browser`. Prefer setting `engine` explicitly to avoid default surprises.",
    ),
  models: z
    .array(z.string())
    .optional()
    .describe("Multi-model fan-out (API engine only). Cannot be combined with browser automation."),
  engine: z
    .enum(["api", "browser"])
    .optional()
    .describe(
      "Execution engine. `api` uses OpenAI/other providers. `browser` automates the ChatGPT web UI (supports attachments and ChatGPT-only model labels). When omitted, Oracle follows CLI defaults: config/ORACLE_ENGINE first, then `api` when OPENAI_API_KEY is set, otherwise `browser`.",
    ),
  browserModelLabel: z
    .string()
    .optional()
    .describe(
      'Browser-only: explicit ChatGPT UI label to select (overrides model mapping). Example: "GPT-5.2 Thinking".',
    ),
  browserAttachments: z
    .enum(["auto", "never", "always"])
    .optional()
    .describe(
      'Browser-only: how to deliver `files`. Use "always" for real ChatGPT file uploads (including images/PDFs). Use "never" to paste file contents inline. "auto" chooses based on prompt size.',
    ),
  browserBundleFiles: z
    .boolean()
    .optional()
    .describe("Browser-only: bundle many files into a single upload (helps with upload limits)."),
  browserThinkingTime: z
    .enum(["light", "standard", "extended", "heavy"])
    .optional()
    .describe("Browser-only: set ChatGPT thinking time when supported by the chosen model."),
  browserModelStrategy: z
    .enum(["select", "current", "ignore"])
    .optional()
    .describe(
      "Browser-only: model picker strategy. Mirrors the CLI --browser-model-strategy flag.",
    ),
  browserResearchMode: z
    .enum(["deep"])
    .optional()
    .describe("Browser-only: activate ChatGPT Deep Research mode for broad web research."),
  browserArchive: z
    .enum(["auto", "always", "never"])
    .optional()
    .describe(
      'Browser-only: archive completed ChatGPT conversations after local artifacts are saved. "auto" archives successful non-project one-shots only.',
    ),
  browserFollowUps: z
    .array(z.string())
    .optional()
    .describe(
      "Browser-only: additional prompts to submit sequentially in the same ChatGPT conversation after the initial answer.",
    ),
  browserKeepBrowser: z
    .boolean()
    .optional()
    .describe("Browser-only: keep Chrome running after completion (useful for debugging)."),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Preview the resolved Oracle run without creating a session or touching the browser.",
    ),
  search: z
    .boolean()
    .optional()
    .describe("API-only: enable/disable the provider search tool (browser engine ignores this)."),
  slug: z
    .string()
    .optional()
    .describe("Optional human-friendly session id (used for later `oracle sessions` lookups)."),
} satisfies z.ZodRawShape;

const consultModelSummaryShape = z.object({
  model: z.string(),
  status: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      reasoningTokens: z.number().optional(),
      totalTokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
  response: z
    .object({
      id: z.string().optional(),
      requestId: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
  error: z
    .object({
      category: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  logPath: z.string().optional(),
});

const consultDryRunResolvedShape = z.object({
  resolvedEngine: z.enum(["api", "browser"]),
  model: z.string(),
  models: z.array(z.string()).optional(),
  files: z.array(z.string()),
  followUpCount: z.number(),
  browser: z
    .object({
      desiredModel: z.string().nullable().optional(),
      thinkingTime: z.string().nullable().optional(),
      modelStrategy: z.string().nullable().optional(),
      researchMode: z.string().nullable().optional(),
      attachments: z.string().optional(),
      bundleFiles: z.boolean().optional(),
      keepBrowser: z.boolean().optional(),
      manualLogin: z.boolean().optional(),
      profileDir: z.string().nullable().optional(),
      chatgptUrl: z.string().nullable().optional(),
    })
    .optional(),
  guidance: z.array(z.string()),
});

const consultOutputShape = {
  sessionId: z.string().optional(),
  status: z.string(),
  output: z.string(),
  dryRun: z.boolean().optional(),
  resolved: consultDryRunResolvedShape.optional(),
  models: z.array(consultModelSummaryShape).optional(),
} satisfies z.ZodRawShape;

export type ConsultModelSummary = z.infer<typeof consultModelSummaryShape>;
export type ConsultDryRunResolved = z.infer<typeof consultDryRunResolvedShape>;

export function summarizeModelRunsForConsult(
  runs?: SessionModelRun[] | null,
): ConsultModelSummary[] | undefined {
  if (!runs || runs.length === 0) {
    return undefined;
  }
  return runs.map((run) => {
    const response = run.response
      ? {
          id: run.response.id ?? undefined,
          requestId: run.response.requestId ?? undefined,
          status: run.response.status ?? undefined,
        }
      : undefined;
    const error = run.error
      ? {
          category: run.error.category,
          message: run.error.message,
        }
      : undefined;
    return {
      model: run.model,
      status: run.status ?? "unknown",
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      usage: run.usage,
      response,
      error,
      logPath: run.log?.path,
    };
  });
}

export function buildConsultBrowserConfig({
  userConfig,
  env,
  runModel,
  inputModel,
  browserModelLabel,
  browserThinkingTime,
  browserModelStrategy,
  browserResearchMode,
  browserArchive,
  browserKeepBrowser,
}: {
  userConfig: UserConfig;
  env: Record<string, string | undefined>;
  runModel: string;
  inputModel?: string;
  browserModelLabel?: string;
  browserThinkingTime?: "light" | "standard" | "extended" | "heavy";
  browserModelStrategy?: BrowserModelStrategy;
  browserResearchMode?: "deep";
  browserArchive?: "auto" | "always" | "never";
  browserKeepBrowser?: boolean;
}): BrowserSessionConfig {
  const configuredBrowser = userConfig.browser ?? {};
  const envProfileDir = (env.ORACLE_BROWSER_PROFILE_DIR ?? "").trim();
  const hasProfileDir = envProfileDir.length > 0;
  const preferredLabel = (browserModelLabel ?? inputModel)?.trim();
  const isChatGptModel = runModel.startsWith("gpt-") && !runModel.includes("codex");
  const desiredModelLabel = isChatGptModel
    ? mapModelToBrowserLabel(runModel)
    : resolveBrowserModelLabel(preferredLabel, runModel);
  const configuredUrl = configuredBrowser.chatgptUrl ?? configuredBrowser.url ?? CHATGPT_URL;
  const manualLogin = hasProfileDir
    ? true
    : (configuredBrowser.manualLogin ?? process.platform === "win32");

  return {
    ...configuredBrowser,
    url: configuredUrl,
    chatgptUrl: configuredUrl,
    cookieSync: !manualLogin,
    headless: configuredBrowser.headless ?? false,
    hideWindow: configuredBrowser.hideWindow ?? false,
    keepBrowser: browserKeepBrowser ?? configuredBrowser.keepBrowser ?? false,
    manualLogin,
    manualLoginProfileDir: manualLogin
      ? ((envProfileDir || configuredBrowser.manualLoginProfileDir) ?? null)
      : null,
    thinkingTime: browserThinkingTime ?? configuredBrowser.thinkingTime,
    modelStrategy: browserModelStrategy ?? configuredBrowser.modelStrategy,
    researchMode: browserResearchMode ?? configuredBrowser.researchMode,
    archiveConversations: browserArchive ?? configuredBrowser.archiveConversations,
    desiredModel: desiredModelLabel || mapModelToBrowserLabel(runModel),
  };
}

export function buildConsultDryRunResolved({
  resolvedEngine,
  runOptions,
  browserConfig,
}: {
  resolvedEngine: "api" | "browser";
  runOptions: ReturnType<typeof mapConsultToRunOptions>["runOptions"];
  browserConfig?: BrowserSessionConfig;
}): ConsultDryRunResolved {
  const guidance: string[] = [];
  const followUpCount = runOptions.browserFollowUps?.filter((entry) => entry.trim()).length ?? 0;
  if (resolvedEngine === "api") {
    guidance.push(
      'API engine requires provider credentials. If the operator has ChatGPT Pro but no API key, retry with engine:"browser" or preset:"chatgpt-pro-heavy".',
    );
  }
  if (resolvedEngine === "browser") {
    guidance.push(
      "Browser engine uses the signed-in ChatGPT profile; run dryRun:true before live use.",
    );
    if (browserConfig?.manualLogin) {
      const profile = browserConfig.manualLoginProfileDir ?? "~/.oracle/browser-profile";
      guidance.push(
        `Manual-login browser mode uses Oracle's private Chrome profile at ${profile}, separate from your normal Chrome profile.`,
      );
      guidance.push(
        `First-time setup: run oracle --engine browser --browser-manual-login --browser-keep-browser --browser-manual-login-profile-dir ${JSON.stringify(profile)} -p "HI", sign into ChatGPT in that window, then retry the consult.`,
      );
      guidance.push(
        "If this profile is not signed in, non-setup MCP/browser runs fail fast instead of waiting for the full browser timeout.",
      );
    }
  }
  const desiredModel = browserConfig?.desiredModel ?? null;
  const thinkingTime = browserConfig?.thinkingTime ?? null;
  if (runOptions.model === "gpt-5.5-pro" && thinkingTime === "heavy") {
    guidance.push(
      'gpt-5.5-pro should normally use Pro Extended. Use model:"gpt-5.5" with browserThinkingTime:"heavy" only when you explicitly want Thinking Heavy.',
    );
  }
  const chatgptUrl = browserConfig?.chatgptUrl ?? browserConfig?.url ?? null;
  if (chatgptUrl?.includes("/project")) {
    guidance.push(
      "This ChatGPT project URL is persistent. Project Sources should be mutated only by the project_sources tool with confirmMutation:true.",
    );
  }
  if (followUpCount > 0) {
    guidance.push(
      "This is a multi-turn browser consult; all follow-ups stay in one ChatGPT conversation.",
    );
  }
  return {
    resolvedEngine,
    model: runOptions.model,
    models: runOptions.models,
    files: runOptions.file ?? [],
    followUpCount,
    browser:
      resolvedEngine === "browser"
        ? {
            desiredModel,
            thinkingTime,
            modelStrategy: browserConfig?.modelStrategy ?? null,
            researchMode: browserConfig?.researchMode ?? null,
            attachments: runOptions.browserAttachments,
            bundleFiles: runOptions.browserBundleFiles,
            keepBrowser: browserConfig?.keepBrowser,
            manualLogin: browserConfig?.manualLogin,
            profileDir: browserConfig?.manualLoginProfileDir ?? null,
            chatgptUrl,
          }
        : undefined,
    guidance,
  };
}

export function formatConsultDryRunResolved(details: ConsultDryRunResolved): string[] {
  const lines = [
    "[dry-run] MCP resolved request:",
    `  engine: ${details.resolvedEngine}`,
    `  model: ${details.model}`,
  ];
  if (details.models && details.models.length > 0) {
    lines.push(`  models: ${details.models.join(", ")}`);
  }
  lines.push(`  files: ${details.files.length}`);
  if (details.browser) {
    lines.push(`  browser desired model: ${details.browser.desiredModel ?? "(default)"}`);
    lines.push(`  browser thinking time: ${details.browser.thinkingTime ?? "(default)"}`);
    lines.push(`  browser model strategy: ${details.browser.modelStrategy ?? "(default)"}`);
    lines.push(`  browser research mode: ${details.browser.researchMode ?? "off"}`);
    lines.push(`  browser attachments: ${details.browser.attachments ?? "auto"}`);
    lines.push(`  browser bundle files: ${details.browser.bundleFiles ? "yes" : "no"}`);
    lines.push(`  browser keep browser: ${details.browser.keepBrowser ? "yes" : "no"}`);
    lines.push(`  browser manual login: ${details.browser.manualLogin ? "yes" : "no"}`);
    if (details.browser.profileDir) {
      lines.push(`  browser profile: ${details.browser.profileDir}`);
    }
    if (details.browser.chatgptUrl) {
      lines.push(`  ChatGPT URL: ${details.browser.chatgptUrl}`);
    }
  }
  lines.push(`  follow-ups: ${details.followUpCount}`);
  for (const guidance of details.guidance) {
    lines.push(`  guidance: ${guidance}`);
  }
  return lines;
}

export function registerConsultTool(server: McpServer): void {
  server.registerTool(
    "consult",
    {
      title: "Run an oracle session",
      description:
        'Run an Oracle session (API or ChatGPT browser automation). Use `files` to attach project context. If `engine` is omitted, Oracle follows CLI defaults: config/ORACLE_ENGINE first, then API when OPENAI_API_KEY is set, otherwise browser. Browser GPT-5.5 Pro consults can take many minutes; use `dryRun:true` first when configuring an agent and inspect `sessions`/`oracle status` before retrying. Browser manual-login uses a private Oracle Chrome profile separate from the user\'s normal Chrome; dry-run output includes first-time setup guidance when that path is active. For browser-based image/file uploads, set `browserAttachments:"always"`. Browser consults can include `browserFollowUps` for a multi-turn ChatGPT review in one conversation. Sessions are stored under `ORACLE_HOME_DIR` (shared with the CLI).',
      // Cast to any to satisfy SDK typings across differing Zod versions.
      inputSchema: consultInputShape,
      outputSchema: consultOutputShape,
    },
    async (input: unknown) => {
      const textContent = (text: string) => [{ type: "text" as const, text }];
      let parsedInput;
      try {
        parsedInput = applyConsultPreset(consultInputSchema.parse(input));
      } catch (error) {
        return {
          isError: true,
          content: textContent(error instanceof Error ? error.message : String(error)),
        };
      }
      const {
        prompt,
        files,
        model,
        models,
        engine,
        search,
        browserModelLabel,
        browserAttachments,
        browserBundleFiles,
        browserThinkingTime,
        browserModelStrategy,
        browserResearchMode,
        browserArchive,
        browserFollowUps,
        browserKeepBrowser,
        dryRun,
        slug,
      } = parsedInput;
      const { config: userConfig } = await loadUserConfig();
      const { runOptions, resolvedEngine } = mapConsultToRunOptions({
        prompt,
        files: files ?? [],
        model,
        models,
        engine,
        search,
        browserAttachments,
        browserBundleFiles,
        browserFollowUps,
        userConfig,
        env: process.env,
      });
      const cwd = process.cwd();
      const sendLog = (text: string, level: "info" | "debug" = "info") =>
        server.server
          .sendLoggingMessage(
            LoggingMessageNotificationParamsSchema.parse({
              level,
              data: { text, bytes: Buffer.byteLength(text, "utf8") },
            }),
          )
          .catch(() => {});

      const resolvedRemote = resolveRemoteServiceConfig({ userConfig, env: process.env });

      let browserConfig: BrowserSessionConfig | undefined;
      if (resolvedEngine === "browser") {
        browserConfig = buildConsultBrowserConfig({
          userConfig,
          env: process.env,
          runModel: runOptions.model,
          inputModel: model,
          browserModelLabel,
          browserThinkingTime,
          browserModelStrategy,
          browserResearchMode,
          browserArchive,
          browserKeepBrowser,
        });
      }

      if (dryRun) {
        const lines: string[] = [];
        const log = (line: string): void => {
          lines.push(line);
          sendLog(line);
        };
        const resolved = buildConsultDryRunResolved({
          resolvedEngine,
          runOptions,
          browserConfig,
        });
        await runDryRunSummary({
          engine: resolvedEngine,
          runOptions,
          cwd,
          version: getCliVersion(),
          log,
          browserConfig,
        });
        for (const line of formatConsultDryRunResolved(resolved)) {
          log(line);
        }
        const output = lines.join("\n").trim();
        return {
          content: textContent(output),
          structuredContent: {
            status: "dry-run",
            output,
            dryRun: true,
            resolved,
          },
        };
      }

      const browserGuard = ensureBrowserAvailable(resolvedEngine, {
        remoteHost: resolvedRemote.host,
      });
      if (resolvedEngine === "browser" && browserGuard) {
        return {
          isError: true,
          content: textContent(browserGuard),
        };
      }

      let browserDeps: BrowserSessionRunnerDeps | undefined;
      if (resolvedEngine === "browser" && resolvedRemote.host) {
        if (!resolvedRemote.token) {
          return {
            isError: true,
            content: textContent(
              `Remote host configured (${resolvedRemote.host}) but remote token is missing. Run \`oracle bridge client --connect <...>\` or set ORACLE_REMOTE_TOKEN.`,
            ),
          };
        }
        browserDeps = {
          executeBrowser: createRemoteBrowserExecutor({
            host: resolvedRemote.host,
            token: resolvedRemote.token,
          }),
        };
      }

      const notifications = resolveNotificationSettings({
        cliNotify: undefined,
        cliNotifySound: undefined,
        env: process.env,
        config: userConfig.notify,
      });

      const sessionMeta = await sessionStore.createSession(
        {
          ...runOptions,
          mode: resolvedEngine,
          slug,
          browserConfig,
          waitPreference: true,
        },
        cwd,
        notifications,
      );

      const logWriter = sessionStore.createLogWriter(sessionMeta.id);
      // Stream logs to both the session log and MCP logging notifications, but avoid buffering in memory
      const log = (line?: string): void => {
        logWriter.logLine(line);
        if (line !== undefined) {
          sendLog(line);
        }
      };
      const write = (chunk: string): boolean => {
        logWriter.writeChunk(chunk);
        sendLog(chunk, "debug");
        return true;
      };

      try {
        await performSessionRun({
          sessionMeta,
          runOptions,
          mode: resolvedEngine,
          browserConfig,
          cwd,
          log,
          write,
          version: getCliVersion(),
          notifications,
          muteStdout: true,
          browserDeps,
        });
      } catch (error) {
        log(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
          isError: true,
          content: textContent(
            `Session ${sessionMeta.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      } finally {
        logWriter.stream.end();
      }

      try {
        const finalMeta = (await sessionStore.readSession(sessionMeta.id)) ?? sessionMeta;
        const summary = `Session ${sessionMeta.id} (${finalMeta.status})`;
        const logTail = await readSessionLogTail(sessionMeta.id, 4000);
        const modelsSummary = summarizeModelRunsForConsult(finalMeta.models);
        return {
          content: textContent([summary, logTail || "(log empty)"].join("\n").trim()),
          structuredContent: {
            sessionId: sessionMeta.id,
            status: finalMeta.status,
            output: logTail ?? "",
            models: modelsSummary,
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: textContent(
            `Session completed but metadata fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }
    },
  );
}
