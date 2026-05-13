import { createHash } from "node:crypto";
import chalk from "chalk";
import {
  MODEL_CONFIGS,
  TOKENIZER_OPTIONS,
  DEFAULT_SYSTEM_PROMPT,
  buildPrompt,
  readFiles,
  getFileTokenStats,
  type RunOracleOptions,
  type PreviewMode,
  type FileContent,
  type FileTokenStats,
} from "../oracle.js";
import { isKnownModel } from "../oracle/modelResolver.js";
import { assembleBrowserPrompt, type BrowserPromptArtifacts } from "../browser/prompt.js";
import type { BrowserAttachment } from "../browser/types.js";
import type { BrowserSessionConfig } from "../sessionStore.js";
import { buildTokenEstimateSuffix, formatAttachmentLabel } from "../browser/promptSummary.js";
import { buildCookiePlan } from "../browser/policies.js";
import { describeBrowserControlPlan, formatBrowserControlPlan } from "../browser/controlPlan.js";

interface DryRunDeps {
  readFilesImpl?: typeof readFiles;
  assembleBrowserPromptImpl?: typeof assembleBrowserPrompt;
}

export const DRY_RUN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export async function runDryRunSummary(
  {
    engine,
    runOptions,
    cwd,
    version,
    log,
    browserConfig,
  }: {
    engine: "api" | "browser";
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    log: (message: string) => void;
    browserConfig?: BrowserSessionConfig;
  },
  deps: DryRunDeps = {},
): Promise<void> {
  if (engine === "browser") {
    await runBrowserDryRun({ runOptions, cwd, version, log, browserConfig }, deps);
    return;
  }
  await runApiDryRun({ runOptions, cwd, version, log }, deps);
}

async function runApiDryRun(
  {
    runOptions,
    cwd,
    version,
    log,
  }: {
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    log: (message: string) => void;
  },
  deps: DryRunDeps,
): Promise<void> {
  const readFilesImpl = deps.readFilesImpl ?? readFiles;
  const files = sortFiles(await readFilesImpl(runOptions.file ?? [], { cwd }));
  const systemPrompt = runOptions.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const combinedPrompt = buildPrompt(runOptions.prompt ?? "", files, cwd);
  const modelConfig = isKnownModel(runOptions.model)
    ? MODEL_CONFIGS[runOptions.model]
    : MODEL_CONFIGS["gpt-5.1"];
  const tokenizer = modelConfig.tokenizer;
  const estimatedInputTokens = tokenizer(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: combinedPrompt },
    ],
    TOKENIZER_OPTIONS,
  );
  const headerLine = `[dry-run] Oracle (${version}) would call ${runOptions.model} with ~${estimatedInputTokens.toLocaleString()} tokens and ${files.length} files.`;
  log(styleLine(headerLine, "cyan"));
  logDryRunPlan({ engine: "api", runOptions, log });
  if (files.length === 0) {
    log(styleLine("[dry-run] No files matched the provided --file patterns.", "dim"));
    return;
  }
  const inputBudget = runOptions.maxInput ?? modelConfig.inputLimit;
  const stats = getFileTokenStats(files, {
    cwd,
    tokenizer,
    tokenizerOptions: TOKENIZER_OPTIONS,
    inputTokenBudget: inputBudget,
  });
  printDeterministicFileTokenStats(stats, { inputTokenBudget: inputBudget, log });
}

async function runBrowserDryRun(
  {
    runOptions,
    cwd,
    version,
    log,
    browserConfig,
  }: {
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    log: (message: string) => void;
    browserConfig?: BrowserSessionConfig;
  },
  deps: DryRunDeps,
): Promise<void> {
  validateBrowserFollowUps(runOptions, browserConfig);
  const assemblePromptImpl = deps.assembleBrowserPromptImpl ?? assembleBrowserPrompt;
  const artifacts = await assemblePromptImpl(runOptions, { cwd });
  const suffix = buildTokenEstimateSuffix(artifacts);
  const headerLine = `[dry-run] Oracle (${version}) would launch browser mode (${runOptions.model}) with ~${artifacts.estimatedInputTokens.toLocaleString()} tokens${suffix}.`;
  log(styleLine(headerLine, "cyan"));
  logDryRunPlan({ engine: "browser", runOptions, browserConfig, log });
  logBrowserControlPlan(browserConfig, log, "dry-run");
  logBrowserFollowUpSummary(runOptions.browserFollowUps, log, "dry-run");
  logBrowserCookieStrategy(browserConfig, log, "dry-run");
  logBrowserArchivePolicy(browserConfig, log, "dry-run");
  logBrowserFileSummary(artifacts, log, "dry-run");
}

function logBrowserControlPlan(
  browserConfig: BrowserSessionConfig | undefined,
  log: (message: string) => void,
  label: string,
) {
  const plan = describeBrowserControlPlan(browserConfig);
  for (const line of formatBrowserControlPlan(plan, label)) {
    log(styleLine(line, "dim"));
  }
}

function logBrowserCookieStrategy(
  browserConfig: BrowserSessionConfig | undefined,
  log: (message: string) => void,
  label: string,
) {
  if (!browserConfig) return;
  const plan = buildCookiePlan(sortCookieNames(browserConfig));
  log(styleLine(`[${label}] ${plan.description}`, "bold"));
}

function logBrowserArchivePolicy(
  browserConfig: BrowserSessionConfig | undefined,
  log: (message: string) => void,
  label: string,
) {
  const mode = browserConfig?.archiveConversations ?? "auto";
  log(styleLine(`[${label}] ChatGPT archive policy: ${mode}.`, "dim"));
}

function logBrowserFileSummary(
  artifacts: BrowserPromptArtifacts,
  log: (message: string) => void,
  label: string,
) {
  if (artifacts.attachments.length > 0) {
    const prefix = artifacts.bundled
      ? `[${label}] Bundled upload:`
      : `[${label}] Attachments to upload:`;
    log(styleLine(prefix, "bold"));
    sortAttachments(artifacts.attachments).forEach((attachment: BrowserAttachment) => {
      log(`  • ${formatAttachmentLabel(attachment)}`);
    });
    if (artifacts.bundled) {
      log(
        styleLine(
          `  (bundled ${artifacts.bundled.originalCount} files into ${artifacts.bundled.bundlePath})`,
          "dim",
        ),
      );
    }
    return;
  }
  if (artifacts.inlineFileCount > 0) {
    log(styleLine(`[${label}] Inline file content:`, "bold"));
    log(
      `  • ${artifacts.inlineFileCount} file${artifacts.inlineFileCount === 1 ? "" : "s"} pasted directly into the composer.`,
    );
    return;
  }
  log(styleLine(`[${label}] No files attached.`, "dim"));
}

export async function runBrowserPreview(
  {
    runOptions,
    cwd,
    version,
    previewMode,
    log,
    browserConfig,
  }: {
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    previewMode: PreviewMode;
    log: (message: string) => void;
    browserConfig?: BrowserSessionConfig;
  },
  deps: DryRunDeps = {},
): Promise<void> {
  validateBrowserFollowUps(runOptions, browserConfig);
  const assemblePromptImpl = deps.assembleBrowserPromptImpl ?? assembleBrowserPrompt;
  const artifacts = await assemblePromptImpl(runOptions, { cwd });
  const suffix = buildTokenEstimateSuffix(artifacts);
  const headerLine = `[preview] Oracle (${version}) browser mode (${runOptions.model}) with ~${artifacts.estimatedInputTokens.toLocaleString()} tokens${suffix}.`;
  log(styleLine(headerLine, "cyan"));
  logDryRunPlan({ engine: "browser", runOptions, browserConfig, log, label: "preview" });
  logBrowserControlPlan(browserConfig, log, "preview");
  logBrowserFollowUpSummary(runOptions.browserFollowUps, log, "preview");
  logBrowserFileSummary(artifacts, log, "preview");
  if (previewMode === "json" || previewMode === "full") {
    const attachmentSummary = sortAttachments(artifacts.attachments).map((attachment) => ({
      path: attachment.path,
      displayPath: attachment.displayPath,
      sizeBytes: attachment.sizeBytes,
    }));
    const promptEvidence = createPromptEvidence(runOptions.prompt ?? "");
    const previewPayload = {
      attachments: attachmentSummary,
      browserFollowUps: runOptions.browserFollowUps ?? [],
      bundled: artifacts.bundled,
      composerText: artifacts.composerText,
      dryRun: true,
      engine: "browser" as const,
      generatedAt: DRY_RUN_TIMESTAMP,
      inlineFileCount: artifacts.inlineFileCount,
      liveCall: false,
      model: runOptions.model,
      plans: buildDryRunPlans("browser", browserConfig),
      promptEvidence,
      tokenEstimate: artifacts.estimatedInputTokens,
    };
    log("");
    log(styleLine("Preview JSON", "bold"));
    log(stableJsonStringify(previewPayload));
  }
  if (previewMode === "full") {
    log("");
    log(styleLine("Composer Text", "bold"));
    log(artifacts.composerText || styleLine("(empty prompt)", "dim"));
  }
}

function logBrowserFollowUpSummary(
  followUps: string[] | undefined,
  log: (message: string) => void,
  label: string,
): void {
  const count = followUps?.filter((entry) => entry.trim().length > 0).length ?? 0;
  if (count > 0) {
    log(styleLine(`[${label}] Browser follow-ups: ${count} additional prompt(s).`, "bold"));
    log(
      styleLine(
        `[${label}] Multi-turn is explicit only: Oracle will send these prompts in order, but it never invents follow-ups automatically.`,
        "dim",
      ),
    );
  }
}

function logDryRunPlan({
  engine,
  runOptions,
  browserConfig,
  log,
  label = "dry-run",
}: {
  engine: "api" | "browser";
  runOptions: RunOracleOptions;
  browserConfig?: BrowserSessionConfig;
  log: (message: string) => void;
  label?: string;
}): void {
  const promptEvidence = createPromptEvidence(runOptions.prompt ?? "");
  const plans = buildDryRunPlans(engine, browserConfig);
  const lines = [
    `[${label}] Generated at: ${DRY_RUN_TIMESTAMP}.`,
    `[${label}] Route: ${describeRoute(engine, browserConfig)}; model=${runOptions.model}.`,
    `[${label}] Live provider/browser action: disabled; no paid request, browser prompt submission, or browser mutation will run.`,
    `[${label}] Provider/browser locks: ${plans.providerLocks}.`,
    `[${label}] Evidence path plan: ${plans.evidencePath}.`,
    `[${label}] Prompt hash plan: prompt_sha256=${promptEvidence.prompt_sha256}; prompt_manifest_sha256=${promptEvidence.prompt_manifest_sha256}; prompt_bytes=${promptEvidence.prompt_bytes}.`,
    `[${label}] Recovery command plan: ${plans.recoveryCommand}.`,
  ];
  for (const line of lines) {
    log(styleLine(line, "dim"));
  }
}

function buildDryRunPlans(
  engine: "api" | "browser",
  browserConfig?: BrowserSessionConfig,
): {
  evidencePath: string;
  providerLocks: string;
  recoveryCommand: string;
  route: string;
} {
  const route = describeRoute(engine, browserConfig);
  const evidencePath =
    engine === "browser"
      ? "~/.oracle/sessions/<session-id>/meta.json and ~/.oracle/sessions/<session-id>/artifacts/"
      : "~/.oracle/sessions/<session-id>/meta.json";
  const providerLocks =
    engine === "browser"
      ? "not acquired (profile/tab leases are only taken during a live browser run)"
      : "not acquired (provider calls are skipped in dry-run)";
  return {
    evidencePath: `not created in ${route}; live runs would write ${evidencePath}`,
    providerLocks,
    recoveryCommand: 'no session is created; live runs print "oracle session <id>" for reattach',
    route,
  };
}

function describeRoute(engine: "api" | "browser", browserConfig?: BrowserSessionConfig): string {
  if (engine === "api") {
    return "api/local";
  }
  if (browserConfig?.remoteChrome) {
    return `browser/remote-chrome ${browserConfig.remoteChrome.host}:${browserConfig.remoteChrome.port}`;
  }
  if (browserConfig?.attachRunning) {
    return "browser/local-attach";
  }
  return "browser/local-launch";
}

function createPromptEvidence(prompt: string): {
  prompt_sha256: string;
  prompt_manifest_sha256: string;
  prompt_bytes: number;
} {
  const bytes = Buffer.from(prompt, "utf8");
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    prompt_sha256: hash,
    prompt_manifest_sha256: hash,
    prompt_bytes: bytes.byteLength,
  };
}

function printDeterministicFileTokenStats(
  { stats, totalTokens }: FileTokenStats,
  {
    inputTokenBudget,
    log,
  }: { inputTokenBudget?: number; log: (message: string) => void },
): void {
  if (!stats.length) {
    return;
  }
  log(styleLine("File Token Usage", "bold"));
  for (const entry of [...stats].sort(compareTokenStats)) {
    const percentLabel =
      inputTokenBudget && entry.percent != null ? `${entry.percent.toFixed(2)}%` : "n/a";
    log(
      `${entry.tokens.toLocaleString().padStart(10)}  ${percentLabel.padStart(8)}  ${entry.displayPath}`,
    );
  }
  if (inputTokenBudget) {
    const totalPercent = (totalTokens / inputTokenBudget) * 100;
    log(
      `Total: ${totalTokens.toLocaleString()} tokens (${totalPercent.toFixed(
        2,
      )}% of ${inputTokenBudget.toLocaleString()})`,
    );
  } else {
    log(`Total: ${totalTokens.toLocaleString()} tokens`);
  }
}

function compareTokenStats(
  a: FileTokenStats["stats"][number],
  b: FileTokenStats["stats"][number],
): number {
  return b.tokens - a.tokens || compareStrings(a.displayPath, b.displayPath);
}

function sortFiles(files: FileContent[]): FileContent[] {
  return [...files].sort((a, b) => compareStrings(a.path, b.path));
}

function sortAttachments(attachments: BrowserAttachment[]): BrowserAttachment[] {
  return [...attachments].sort(
    (a, b) =>
      compareStrings(a.displayPath, b.displayPath) ||
      compareStrings(a.path, b.path) ||
      (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1),
  );
}

function sortCookieNames(browserConfig: BrowserSessionConfig): BrowserSessionConfig {
  const cookieNames =
    browserConfig.cookieNames && browserConfig.cookieNames.length > 0
      ? [...browserConfig.cookieNames].sort(compareStrings)
      : browserConfig.cookieNames;
  return { ...browserConfig, cookieNames };
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function stableJsonStringify(value: unknown, space = 2): string {
  return JSON.stringify(sortJsonValue(value), null, space);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort(compareStrings)
    .reduce<Record<string, unknown>>((acc, key) => {
      const sortedValue = sortJsonValue(record[key]);
      if (sortedValue !== undefined) {
        acc[key] = sortedValue;
      }
      return acc;
    }, {});
}

function styleLine(message: string, style: "bold" | "cyan" | "dim"): string {
  if (!shouldUseAnsiColor()) {
    return message;
  }
  return chalk[style](message);
}

function shouldUseAnsiColor(): boolean {
  if (process.env.NO_COLOR != null) {
    return false;
  }
  return Boolean(process.stdout.isTTY && chalk.level > 0);
}

function validateBrowserFollowUps(
  runOptions: RunOracleOptions,
  browserConfig: BrowserSessionConfig | undefined,
): void {
  const followUpCount =
    runOptions.browserFollowUps?.filter((entry) => entry.trim().length > 0).length ?? 0;
  if (followUpCount > 0 && browserConfig?.researchMode === "deep") {
    throw new Error(
      "Browser follow-ups are not supported with Deep Research mode. Put the full research plan into the initial prompt or run a normal browser consult for multi-turn review.",
    );
  }
}
