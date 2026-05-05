import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserAttachment } from "../browser/types.js";
import type { BrowserFlagOptions } from "./browserConfig.js";
import { buildBrowserConfig } from "./browserConfig.js";
import { readFiles } from "../oracle/files.js";
import { loadUserConfig } from "../config.js";
import { resolveConfiguredMaxFileSizeBytes } from "./fileSize.js";
import { runBrowserProjectSources } from "../browser/projectSourcesRunner.js";
import type { ProjectSourcesOperation, ProjectSourcesResult } from "../projectSources/types.js";
import { normalizeProjectSourcesUrl } from "../projectSources/url.js";

export interface ProjectSourcesCliOptions extends Partial<BrowserFlagOptions> {
  file?: string[];
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
  chatgptUrl?: string;
  maxFileSizeBytes?: number;
}

export async function runProjectSourcesCliCommand(
  operation: ProjectSourcesOperation,
  options: ProjectSourcesCliOptions,
): Promise<void> {
  const { config: userConfig } = await loadUserConfig();
  const configuredUrl = userConfig.browser?.chatgptUrl ?? userConfig.browser?.url;
  const projectUrl = normalizeProjectSourcesUrl(options.chatgptUrl ?? configuredUrl ?? "");
  const maxFileSizeBytes =
    options.maxFileSizeBytes ?? resolveConfiguredMaxFileSizeBytes(userConfig, process.env);
  const files =
    operation === "add"
      ? await resolveProjectSourceFiles(options.file ?? [], {
          cwd: process.cwd(),
          maxFileSizeBytes,
        })
      : [];
  if (operation === "add" && files.length === 0) {
    throw new Error("project-sources add requires at least one --file.");
  }

  const browserConfig = await buildProjectSourcesBrowserConfig({
    options,
    projectUrl,
    configuredBrowser: userConfig.browser ?? {},
  });
  const result = await runBrowserProjectSources({
    operation,
    chatgptUrl: projectUrl,
    files,
    dryRun: options.dryRun,
    config: browserConfig,
    log: (message) => {
      if (options.verbose || !message.startsWith("[debug]")) {
        console.log(chalk.dim(message));
      }
    },
  });
  printProjectSourcesResult(result, Boolean(options.json));
}

export async function resolveProjectSourceFiles(
  fileInputs: string[],
  options: { cwd: string; maxFileSizeBytes?: number },
): Promise<BrowserAttachment[]> {
  const files = await readFiles(fileInputs, {
    cwd: options.cwd,
    maxFileSizeBytes: options.maxFileSizeBytes,
    readContents: false,
  });
  const attachments: BrowserAttachment[] = [];
  for (const file of files) {
    const stats = await fs.stat(file.path);
    attachments.push({
      path: file.path,
      displayPath: path.relative(options.cwd, file.path) || path.basename(file.path),
      sizeBytes: stats.size,
    });
  }
  return attachments;
}

export async function buildProjectSourcesBrowserConfig({
  options,
  projectUrl,
  configuredBrowser,
}: {
  options: ProjectSourcesCliOptions;
  projectUrl: string;
  configuredBrowser: BrowserSessionConfig;
}): Promise<BrowserSessionConfig> {
  const flagConfig = removeUndefined(
    await buildBrowserConfig({
      ...options,
      model: "gpt-5.5-pro",
      chatgptUrl: projectUrl,
    }),
  );
  const envProfileDir = process.env.ORACLE_BROWSER_PROFILE_DIR?.trim();
  const manualLogin =
    flagConfig.manualLogin ?? configuredBrowser.manualLogin ?? (envProfileDir ? true : undefined);
  const manualLoginProfileDir =
    manualLogin === true
      ? (flagConfig.manualLoginProfileDir ??
        configuredBrowser.manualLoginProfileDir ??
        envProfileDir ??
        null)
      : null;
  return {
    ...configuredBrowser,
    ...flagConfig,
    url: projectUrl,
    chatgptUrl: projectUrl,
    cookieSync: manualLogin ? false : (flagConfig.cookieSync ?? configuredBrowser.cookieSync),
    manualLogin,
    manualLoginProfileDir,
    desiredModel: null,
    modelStrategy: "ignore",
    researchMode: "off",
  };
}

function removeUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function printProjectSourcesResult(result: ProjectSourcesResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "dry-run") {
    console.log(chalk.bold(`Project Sources ${result.operation} dry run`));
    console.log(`Project: ${result.projectUrl}`);
    const plan = result.plannedUploads ?? [];
    if (plan.length > 0) {
      console.log(`Planned uploads: ${plan.length}`);
      for (const upload of plan) {
        console.log(`  batch ${upload.batch}: ${upload.displayPath}`);
      }
    }
    return;
  }
  console.log(chalk.bold(`Project Sources ${result.operation} completed`));
  console.log(`Project: ${result.projectUrl}`);
  const before = result.sourcesBefore?.length ?? 0;
  const after = result.sourcesAfter?.length ?? 0;
  console.log(`Before: ${before}`);
  console.log(`After: ${after}`);
  if (result.added && result.added.length > 0) {
    console.log(`Added: ${result.added.map((source) => source.name).join(", ")}`);
  }
}
