import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

export interface DocsCheckIssue {
  file: string;
  flag: string;
  section?: string;
  command?: string;
}

export interface DocsCheckResult {
  checkedFiles: string[];
  checkedFlags: string[];
  issues: DocsCheckIssue[];
}

const DEFAULT_DOC_PATHS = [
  "README.md",
  "docs/index.md",
  "docs/agents.md",
  "docs/sessions.md",
  "docs/spec.md",
  "docs/cli-reference.md",
];
const FLAG_RE = /(^|[\s`([{|,])(--[a-z][a-z0-9-]*)(?=$|[\s`)[\].,;:|=<>}])/g;
const SLASH_FLAG_RE = /--[a-z][a-z0-9-]*(?:\/(?:--[a-z][a-z0-9-]*|-[a-z][a-z0-9-]*))+/g;
const ROOT_ONLY_SECTIONS = new Set(["Core consult flags"]);

export async function checkDocsFlags({
  command,
  cwd = process.cwd(),
  paths,
}: {
  command: Command;
  cwd?: string;
  paths?: string[];
}): Promise<DocsCheckResult> {
  const availableFlags = collectCommanderFlags(command);
  const rootFlags = collectCommanderFlags(command, { recursive: false });
  const commandFlags = collectCommandFlags(command);
  const docPaths = await resolveDocPaths(cwd, paths);
  const issues: DocsCheckIssue[] = [];
  const checkedFlags = new Set<string>();

  for (const docPath of docPaths) {
    const body = await fs.readFile(path.resolve(cwd, docPath), "utf8");
    for (const reference of extractMarkdownFlagReferences(body)) {
      const { command: commandPath, flag, section } = reference;
      checkedFlags.add(flag);
      const scopedFlags = commandPath
        ? (commandFlags.get(commandPath) ?? availableFlags)
        : section && ROOT_ONLY_SECTIONS.has(section)
          ? rootFlags
          : availableFlags;
      if (!scopedFlags.has(flag)) {
        issues.push({ file: docPath, flag, section, command: commandPath });
      }
    }
  }

  return {
    checkedFiles: docPaths,
    checkedFlags: [...checkedFlags].sort(),
    issues: issues.sort((a, b) => a.file.localeCompare(b.file) || a.flag.localeCompare(b.flag)),
  };
}

export function printDocsCheckResult(result: DocsCheckResult, log = console.log): void {
  if (result.issues.length === 0) {
    log(
      `Docs/help check: ok (${result.checkedFlags.length} flags, ${result.checkedFiles.length} files)`,
    );
    return;
  }
  log("Docs/help drift:");
  for (const issue of result.issues) {
    const scopes = [issue.section, issue.command].filter(Boolean);
    const scope = scopes.length > 0 ? ` (${scopes.join(", ")})` : "";
    log(
      `- ${issue.file}${scope} mentions ${issue.flag}, but CLI help does not expose ${issue.flag}`,
    );
  }
}

export function collectCommanderFlags(
  command: Command,
  options?: { recursive?: boolean },
): Set<string> {
  const flags = new Set<string>(["--help", "--version"]);
  for (const option of command.options) {
    for (const flag of extractOptionFlags(option.flags)) {
      flags.add(flag);
    }
  }
  if (options?.recursive === false) {
    return flags;
  }
  for (const subcommand of command.commands) {
    for (const flag of collectCommanderFlags(subcommand)) {
      flags.add(flag);
    }
  }
  return flags;
}

function collectCommandFlags(command: Command, pathParts = ["oracle"]): Map<string, Set<string>> {
  const flags = new Map<string, Set<string>>();
  flags.set(pathParts.join(" "), collectCommanderFlags(command, { recursive: false }));
  for (const subcommand of command.commands) {
    for (const [path, subcommandFlags] of collectCommandFlags(subcommand, [
      ...pathParts,
      subcommand.name(),
    ])) {
      flags.set(path, subcommandFlags);
    }
  }
  return flags;
}

export function extractMarkdownFlags(markdown: string): string[] {
  return [
    ...new Set(extractMarkdownFlagReferences(markdown).map((reference) => reference.flag)),
  ].sort();
}

interface MarkdownFlagReference {
  flag: string;
  section?: string;
  command?: string;
}

function extractMarkdownFlagReferences(markdown: string): MarkdownFlagReference[] {
  const references: MarkdownFlagReference[] = [];
  let section: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##+\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
    }
    const commandPath = extractOracleCommandPath(line);
    const lineFlags = new Set<string>();
    for (const match of line.matchAll(FLAG_RE)) {
      const flag = match[2];
      if (!flag || flag.endsWith("-")) {
        continue;
      }
      lineFlags.add(flag);
    }
    for (const flag of expandSlashFlagReferences(line)) {
      lineFlags.add(flag);
    }
    for (const flag of lineFlags) {
      references.push({ flag, section, command: commandPath });
    }
  }
  return references.sort(
    (a, b) => a.flag.localeCompare(b.flag) || (a.section ?? "").localeCompare(b.section ?? ""),
  );
}

function extractOracleCommandPath(line: string): string | undefined {
  const trimmed = line.trim().replace(/^[$>]\s+/, "");
  if (!trimmed.startsWith("oracle ") && !trimmed.startsWith("npx ")) {
    return undefined;
  }
  const tokens = trimmed.split(/\s+/);
  let oracleIndex = tokens[0] === "oracle" ? 0 : -1;
  if (oracleIndex === -1) {
    oracleIndex = tokens.findIndex((token) => token === "@steipete/oracle");
  }
  if (oracleIndex === -1) {
    return undefined;
  }
  const pathParts = ["oracle"];
  for (const token of tokens.slice(oracleIndex + 1)) {
    if (token.startsWith("-") || !/^[a-z][a-z0-9-]*$/.test(token)) {
      break;
    }
    pathParts.push(token);
  }
  return pathParts.join(" ");
}

function extractOptionFlags(flagsText: string): string[] {
  const flags = new Set<string>();
  for (const match of flagsText.matchAll(/--\[no-\]([a-z][a-z0-9-]*)/g)) {
    flags.add(`--${match[1]}`);
    flags.add(`--no-${match[1]}`);
  }
  for (const match of flagsText.matchAll(/--[a-z][a-z0-9-]*/g)) {
    flags.add(match[0]);
  }
  return [...flags];
}

function expandSlashFlagReferences(line: string): string[] {
  const flags: string[] = [];
  for (const match of line.matchAll(SLASH_FLAG_RE)) {
    const parts = match[0].split("/");
    const base = parts[0];
    const basePrefix = base.slice(0, base.lastIndexOf("-") + 1);
    flags.push(base);
    for (const part of parts.slice(1)) {
      if (part.startsWith("--")) {
        flags.push(part);
      } else if (part.startsWith("-") && basePrefix) {
        flags.push(`${basePrefix}${part.slice(1)}`);
      }
    }
  }
  return flags;
}

async function resolveDocPaths(cwd: string, paths?: string[]): Promise<string[]> {
  const candidates = paths && paths.length > 0 ? paths : DEFAULT_DOC_PATHS;
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.resolve(cwd, candidate));
      if (stat.isFile()) {
        existing.push(candidate);
      }
    } catch {
      if (paths && paths.length > 0) {
        throw new Error(`Docs check path not found: ${candidate}`);
      }
    }
  }
  if (existing.length === 0) {
    throw new Error("No docs found to check. Run from the repo root or pass --docs-path <file>.");
  }
  return existing;
}
