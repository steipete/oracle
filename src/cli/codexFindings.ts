import chalk from "chalk";
import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserFlagOptions } from "./browserConfig.js";
import { buildBrowserConfig } from "./browserConfig.js";
import { loadUserConfig } from "../config.js";
import { runBrowserCodexFindings } from "../browser/codexFindingsRunner.js";
import { normalizeCodexFindingsUrl } from "../codex/url.js";
import type { CodexFindingsResult } from "../codex/types.js";

export interface CodexFindingsCliOptions extends Partial<BrowserFlagOptions> {
  chatgptUrl?: string;
  severity?: string;
  finding?: string;
  limit?: number;
  json?: boolean;
  verbose?: boolean;
}

export async function runCodexFindingsCliCommand(options: CodexFindingsCliOptions): Promise<void> {
  const { config: userConfig } = await loadUserConfig();
  const configuredUrl = userConfig.browser?.chatgptUrl ?? userConfig.browser?.url;
  const findingsUrl = normalizeCodexFindingsUrl(options.chatgptUrl ?? configuredUrl ?? "");
  const browserConfig = await buildCodexFindingsBrowserConfig({
    options,
    findingsUrl,
    configuredBrowser: userConfig.browser ?? {},
  });
  const result = await runBrowserCodexFindings({
    operation: options.finding ? "detail" : "list",
    chatgptUrl: findingsUrl,
    findingId: options.finding,
    severity: options.severity,
    limit: options.limit,
    config: browserConfig,
    log: (message) => {
      if (options.verbose || !message.startsWith("[debug]")) {
        console.log(chalk.dim(message));
      }
    },
  });
  printCodexFindingsResult(result, Boolean(options.json));
}

export async function buildCodexFindingsBrowserConfig({
  options,
  findingsUrl,
  configuredBrowser,
}: {
  options: CodexFindingsCliOptions;
  findingsUrl: string;
  configuredBrowser: BrowserSessionConfig;
}): Promise<BrowserSessionConfig> {
  const flagConfig = removeUndefined(
    await buildBrowserConfig({
      ...options,
      model: "gpt-5.5-pro",
      chatgptUrl: findingsUrl,
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
    url: findingsUrl,
    chatgptUrl: findingsUrl,
    // Default (no manual-login): sync cookies from the active Chrome profile so any signed-in
    // profile works without extra setup.
    cookieSync: manualLogin
      ? false
      : (flagConfig.cookieSync ?? configuredBrowser.cookieSync ?? true),
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

function printCodexFindingsResult(result: CodexFindingsResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.operation === "detail" && result.detail) {
    const d = result.detail;
    console.log(chalk.bold(d.title || "(untitled finding)"));
    if (d.repo) console.log(chalk.dim(d.repo));
    for (const section of d.sections) {
      console.log("");
      console.log(chalk.bold(`# ${section.heading}`));
      console.log(section.text);
    }
    if (d.files.length > 0) {
      console.log("");
      console.log(chalk.bold("# Evidence files"));
      for (const file of d.files) console.log(`  ${file}`);
    }
    if (d.validationArtifact) {
      console.log("");
      console.log(chalk.bold("# Validation artifact (signed, expires soon)"));
      console.log(`  ${d.validationArtifact}`);
    }
    return;
  }
  const findings = result.findings ?? [];
  const counter = result.counter;
  console.log(
    chalk.bold(
      counter
        ? `Codex findings ${counter.from}-${counter.to} of ${counter.total}`
        : "Codex findings",
    ),
  );
  if (findings.length === 0) {
    console.log(chalk.dim("No findings."));
    return;
  }
  for (const finding of findings) {
    const idLabel = finding.selectionId ?? finding.id;
    console.log(`${chalk.dim(idLabel)}  ${sevLabel(finding.severity)}  ${finding.title}`);
    if (finding.repo) console.log(chalk.dim(`    ${finding.repo}`));
  }
}

function sevLabel(severity: string): string {
  const pad = severity.toUpperCase().padEnd(8);
  switch (severity) {
    case "critical":
      return chalk.red.bold(pad);
    case "high":
      return chalk.red(pad);
    case "medium":
      return chalk.yellow(pad);
    case "low":
      return chalk.blue(pad);
    default:
      return chalk.dim(pad);
  }
}
