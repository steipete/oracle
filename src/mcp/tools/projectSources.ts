import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadUserConfig } from "../../config.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import { runBrowserProjectSources } from "../../browser/projectSourcesRunner.js";
import { normalizeProjectSourcesUrl } from "../../projectSources/url.js";
import {
  buildProjectSourcesBrowserConfig,
  resolveProjectSourceFiles,
} from "../../cli/projectSources.js";
import { resolveConfiguredMaxFileSizeBytes } from "../../cli/fileSize.js";

const projectSourceEntryShape = z.object({
  name: z.string(),
  index: z.number(),
  status: z.enum(["ready", "processing", "unknown"]).optional(),
});

const projectSourceUploadPlanShape = z.object({
  path: z.string(),
  displayPath: z.string(),
  name: z.string(),
  sizeBytes: z.number().optional(),
  batch: z.number(),
});

const projectSourcesInputShape = {
  operation: z
    .enum(["list", "add"])
    .describe(
      "Project Sources operation. v1 intentionally supports only non-destructive list/add.",
    ),
  chatgptUrl: z
    .string()
    .optional()
    .describe("ChatGPT project URL ending in /project. Falls back to browser.chatgptUrl config."),
  files: z
    .array(z.string())
    .default([])
    .describe("Local file paths or globs to add as persistent ChatGPT Project Sources."),
  dryRun: z
    .boolean()
    .optional()
    .describe("Validate files and return an upload plan without touching the browser."),
  confirmMutation: z
    .boolean()
    .optional()
    .describe(
      "Required for mutating add operations so agents do not modify project state accidentally.",
    ),
  browserKeepBrowser: z.boolean().optional().describe("Keep Chrome running after completion."),
} satisfies z.ZodRawShape;

const projectSourcesOutputShape = {
  status: z.enum(["ok", "dry-run"]),
  operation: z.enum(["list", "add"]),
  projectUrl: z.string(),
  dryRun: z.boolean(),
  sourcesBefore: z.array(projectSourceEntryShape).optional(),
  sourcesAfter: z.array(projectSourceEntryShape).optional(),
  plannedUploads: z.array(projectSourceUploadPlanShape).optional(),
  added: z.array(projectSourceEntryShape).optional(),
  warnings: z.array(z.string()),
  tookMs: z.number(),
} satisfies z.ZodRawShape;

const projectSourcesInputSchema = z.object(projectSourcesInputShape);

export function registerProjectSourcesTool(server: McpServer): void {
  server.registerTool(
    "project_sources",
    {
      title: "Manage ChatGPT Project Sources",
      description:
        "List or append files to a ChatGPT Project's persistent Sources tab. This is useful for Developer Mode workflows where chats do not share memory, but explicit project sources provide shared context. Destructive delete/replace/sync operations are intentionally not included in v1.",
      inputSchema: projectSourcesInputShape,
      outputSchema: projectSourcesOutputShape,
    },
    async (input: unknown) => {
      const textContent = (text: string) => [{ type: "text" as const, text }];
      let parsed;
      try {
        parsed = projectSourcesInputSchema.parse(input);
      } catch (error) {
        return {
          isError: true,
          content: textContent(error instanceof Error ? error.message : String(error)),
        };
      }
      const { config: userConfig } = await loadUserConfig();
      const resolvedRemote = resolveRemoteServiceConfig({ userConfig, env: process.env });
      if (resolvedRemote.host) {
        return {
          isError: true,
          content: textContent(
            "project_sources v1 must run on the signed-in browser host; remote oracle serve support is not enabled yet.",
          ),
        };
      }
      const projectUrl = normalizeProjectSourcesUrl(
        parsed.chatgptUrl ?? userConfig.browser?.chatgptUrl ?? userConfig.browser?.url ?? "",
      );
      if (parsed.operation === "add" && !parsed.dryRun && parsed.confirmMutation !== true) {
        return {
          isError: true,
          content: textContent(
            "project_sources add modifies persistent ChatGPT Project Sources. Retry with `confirmMutation: true` or use `dryRun: true` first.",
          ),
        };
      }
      const maxFileSizeBytes = resolveConfiguredMaxFileSizeBytes(userConfig, process.env);
      const files =
        parsed.operation === "add"
          ? await resolveProjectSourceFiles(parsed.files ?? [], {
              cwd: process.cwd(),
              maxFileSizeBytes,
            })
          : [];
      const browserConfig = await buildProjectSourcesBrowserConfig({
        options: {
          chatgptUrl: projectUrl,
          browserKeepBrowser: parsed.browserKeepBrowser,
        },
        projectUrl,
        configuredBrowser: userConfig.browser ?? {},
      });
      const result = await runBrowserProjectSources({
        operation: parsed.operation,
        chatgptUrl: projectUrl,
        files,
        dryRun: parsed.dryRun,
        config: browserConfig,
        log: (message) => {
          server.server
            .sendLoggingMessage({ level: "info", data: { text: message } })
            .catch(() => undefined);
        },
      });
      const output =
        result.status === "dry-run"
          ? `Project Sources ${result.operation} dry run: ${result.plannedUploads?.length ?? 0} planned upload(s).`
          : `Project Sources ${result.operation} completed: ${result.sourcesAfter?.length ?? 0} source(s).`;
      return {
        content: textContent(output),
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
