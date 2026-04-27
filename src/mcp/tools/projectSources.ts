import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runBrowserMode } from "../../browserMode.js";
import { buildConsultBrowserConfig } from "./consult.js";
import { loadUserConfig } from "../../config.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import { createRemoteBrowserExecutor } from "../../remote/client.js";
import { ensureBrowserAvailable } from "../utils.js";

const projectSourcesInputShape = {
  operation: z
    .enum(["add", "delete", "replace", "sync"])
    .describe("Project Sources operation to run."),
  files: z
    .array(z.string())
    .default([])
    .describe("Local files to upload into ChatGPT project Sources."),
  sourceNames: z
    .array(z.string())
    .default([])
    .describe("Existing project source names to delete/replace."),
  chatgptUrl: z
    .string()
    .optional()
    .describe("Optional ChatGPT project URL override. Should point at a project URL."),
  browserKeepBrowser: z
    .boolean()
    .optional()
    .describe("Keep the browser open after completion."),
  browserThinkingTime: z
    .enum(["light", "standard", "extended", "heavy"])
    .optional()
    .describe("Passed through to the browser config when available."),
} satisfies z.ZodRawShape;

const projectSourcesOutputShape = {
  operation: z.enum(["add", "delete", "replace", "sync"]),
  beforeNames: z.array(z.string()),
  afterNames: z.array(z.string()),
  addedNames: z.array(z.string()),
  deletedNames: z.array(z.string()),
  output: z.string(),
} satisfies z.ZodRawShape;

const projectSourcesInputSchema = z.object(projectSourcesInputShape);

export function registerProjectSourcesTool(server: McpServer): void {
  server.registerTool(
    "project_sources",
    {
      title: "Manage ChatGPT project sources",
      description:
        "Manage a ChatGPT project's persistent Sources tab directly in browser mode. Supports add, delete, replace, and sync against a project URL.",
      inputSchema: projectSourcesInputShape,
      outputSchema: projectSourcesOutputShape,
    },
    async (input: unknown) => {
      const textContent = (text: string) => [{ type: "text" as const, text }];
      const { operation, files, sourceNames, chatgptUrl, browserKeepBrowser, browserThinkingTime } =
        projectSourcesInputSchema.parse(input);
      const { config: userConfig } = await loadUserConfig();
      const resolvedRemote = resolveRemoteServiceConfig({ userConfig, env: process.env });
      const browserGuard = ensureBrowserAvailable("browser", {
        remoteHost: resolvedRemote.host,
      });
      if (browserGuard) {
        return {
          isError: true,
          content: textContent(browserGuard),
        };
      }

      const browserConfig = buildConsultBrowserConfig({
        userConfig,
        env: process.env,
        runModel: "gpt-5.4-pro",
        inputModel: "gpt-5.4-pro",
        browserKeepBrowser,
        browserThinkingTime,
      });
      const targetUrl = chatgptUrl?.trim() || browserConfig.chatgptUrl || browserConfig.url;
      if (!targetUrl || !targetUrl.includes("/project")) {
        return {
          isError: true,
          content: textContent(
            "project_sources requires a ChatGPT project URL. Pass `chatgptUrl` or set `browser.chatgptUrl` in Oracle config.",
          ),
        };
      }
      browserConfig.url = targetUrl;
      browserConfig.chatgptUrl = targetUrl;

      const attachments = await Promise.all(
        files.map(async (filePath) => {
          const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
          const stats = await fs.stat(absolutePath);
          return {
            path: absolutePath,
            displayPath: path.relative(process.cwd(), absolutePath) || path.basename(absolutePath),
            sizeBytes: stats.size,
          };
        }),
      );
      if (operation === "delete" && sourceNames.length === 0) {
        return {
          isError: true,
          content: textContent("project_sources delete requires at least one `sourceNames` entry."),
        };
      }
      if (operation !== "delete" && attachments.length === 0) {
        return {
          isError: true,
          content: textContent(`project_sources ${operation} requires at least one file.`),
        };
      }

      const executeBrowser =
        resolvedRemote.host && resolvedRemote.token
          ? createRemoteBrowserExecutor({
              host: resolvedRemote.host,
              token: resolvedRemote.token,
            })
          : runBrowserMode;
      const result = await executeBrowser({
        prompt: "",
        attachments,
        projectSources: {
          operation,
          deleteNames: sourceNames,
        },
        config: browserConfig,
      });
      const projectSources = result.projectSources;
      if (!projectSources) {
        throw new Error("Browser project sources run completed without a projectSources result.");
      }

      return {
        content: textContent(result.answerMarkdown || result.answerText),
        structuredContent: {
          operation: projectSources.operation,
          beforeNames: projectSources.beforeNames,
          afterNames: projectSources.afterNames,
          addedNames: projectSources.addedNames,
          deletedNames: projectSources.deletedNames,
          output: result.answerMarkdown || result.answerText,
        },
      };
    },
  );
}
