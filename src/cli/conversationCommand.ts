import fs from "node:fs/promises";
import path from "node:path";
import {
  exportChatGptConversation,
  type ConversationExport,
  type ConversationRecord,
  type ExportConversationOptions,
} from "../browser/conversationExport.js";
import { renderObsidianVault, todayInTimezone } from "./conversationObsidian.js";

export type ConversationFormat = "json" | "markdown" | "raw" | "obsidian";
export type ConversationEngine = "api" | "dom";

/** Minimal fs surface renderObsidianVault's writer needs; DI point for tests. */
export interface ConversationObsidianFs {
  mkdir(dirPath: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(filePath: string, content: string, encoding: "utf8"): Promise<void>;
  readdir(dirPath: string): Promise<string[]>;
}

const defaultObsidianFs: ConversationObsidianFs = {
  mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
  writeFile: (filePath, content, encoding) => fs.writeFile(filePath, content, encoding),
  readdir: (dirPath) => fs.readdir(dirPath),
};

async function isNonEmptyDir(fsImpl: ConversationObsidianFs, dirPath: string): Promise<boolean> {
  try {
    const entries = await fsImpl.readdir(dirPath);
    return entries.length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

function renderV1MarkdownRecord(record: ConversationRecord): string {
  const content =
    record.role === "assistant"
      ? (record.markdown ?? record.text ?? `[redacted: ${record.textHash}]`)
      : (record.text ?? `[redacted: ${record.textHash}]`);
  return `## ${record.ordinal + 1}. ${record.role}\n\n${content}`;
}

function renderV2MarkdownRecord(record: ConversationRecord): string {
  const heading = `## ${record.turnIndex ?? record.ordinal + 1}. ${record.role}`;
  const lines: string[] = [heading, ""];
  if (record.role === "assistant" && (record.segments?.length ?? 0) === 0) {
    const hidden =
      record.hiddenNodes && record.hiddenNodes.length > 0 ? record.hiddenNodes.join(", ") : "none";
    lines.push(`_(no visible assistant text; hidden nodes: ${hidden})_`);
  } else {
    const content =
      record.role === "assistant"
        ? (record.markdown ?? record.text ?? `[redacted: ${record.textHash}]`)
        : (record.text ?? `[redacted: ${record.textHash}]`);
    lines.push(content);
  }
  if (record.role === "user" && record.attachments && record.attachments.length > 0) {
    lines.push("");
    for (const attachment of record.attachments) {
      const pointer = attachment.asset_pointer ?? "unknown";
      const width = attachment.width ?? "?";
      const height = attachment.height ?? "?";
      lines.push(`- attachment: ${pointer} (${width}x${height})`);
    }
  }
  return lines.join("\n");
}

export function renderConversationExport(
  value: ConversationExport,
  format: Exclude<ConversationFormat, "obsidian">,
): string {
  if (format === "raw") {
    if (value.raw === undefined) {
      throw new Error(
        "--format raw requires the api engine's raw backend-api body; this export has none (was --source dom, or --include-raw was not requested).",
      );
    }
    return `${JSON.stringify(value.raw, null, 2)}\n`;
  }
  if (format === "json") return `${JSON.stringify(value, null, 2)}\n`;
  const header = [
    `# ChatGPT conversation export`,
    ``,
    `Source: ${value.source.url}`,
    `Complete: ${value.complete ? "yes" : "no"}`,
    ``,
  ];
  const body =
    value.version === 2
      ? value.records.map(renderV2MarkdownRecord)
      : value.records.map(renderV1MarkdownRecord);
  return `${header.join("\n")}\n${body.join("\n\n")}\n`;
}

export async function runConversationExport(
  options: {
    ref?: string;
    host?: string;
    port?: string;
    format?: ConversationFormat;
    output?: string;
    omitText?: boolean;
    engine?: ConversationEngine;
    includeRaw?: boolean;
    timezone?: string;
    captured?: string;
    folder?: string;
    force?: boolean;
  },
  exporter: (
    options: ExportConversationOptions,
  ) => Promise<ConversationExport> = exportChatGptConversation,
  obsidianFs: ConversationObsidianFs = defaultObsidianFs,
): Promise<void> {
  const format = options.format ?? "json";
  const engine = options.engine ?? "api";
  if (format === "raw" && engine !== "api") {
    throw new Error(
      "--format raw requires --source api (the dom source has no backend-api raw body).",
    );
  }
  if (format === "obsidian") {
    if (!options.output) {
      throw new Error(
        "--format obsidian requires --out <dir> (the vault/inbox root to write into).",
      );
    }
    if (engine !== "api") {
      throw new Error(
        "--format obsidian requires --source api (raw archiving needs the backend-api record shape).",
      );
    }
    const value = await exporter({
      ref: options.ref,
      host: options.host,
      port: parseConversationPort(options.port),
      engine,
      includeRaw: false,
    });
    if (value.version !== 2 || !value.conversation) {
      throw new Error(
        "--format obsidian requires a v2 (api source) export; got a legacy dom export.",
      );
    }
    const conversationId = value.source.conversationId ?? "unknown";
    const folderName = options.folder ?? `ChatGPT-${conversationId.slice(0, 8)}`;
    const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const captured = options.captured ?? todayInTimezone(timezone);
    const { files, summary } = renderObsidianVault(value, { timezone, captured, folderName });

    const targetDir = path.join(options.output, folderName);
    if (!options.force && (await isNonEmptyDir(obsidianFs, targetDir))) {
      throw new Error(
        `${targetDir} already exists and is not empty. Pass --force to write into it anyway.`,
      );
    }
    await obsidianFs.mkdir(targetDir, { recursive: true });
    for (const file of files) {
      const fullPath = path.join(options.output, file.relativePath);
      await obsidianFs.mkdir(path.dirname(fullPath), { recursive: true });
      await obsidianFs.writeFile(fullPath, file.content, "utf8");
    }
    console.error(
      `Wrote obsidian vault: ${files.length} files, ${summary.turns} turns, ${summary.exchanges} exchanges, ${summary.dateRangeStart} to ${summary.dateRangeEnd} -> ${targetDir}`,
    );
    return;
  }
  const value = await exporter({
    ref: options.ref,
    host: options.host,
    port: parseConversationPort(options.port),
    redactText: Boolean(options.omitText),
    engine,
    includeRaw: format === "raw" || Boolean(options.includeRaw),
  });
  const rendered = renderConversationExport(value, format);
  if (options.output) {
    await fs.writeFile(options.output, rendered, "utf8");
    console.error(`Wrote conversation export to ${options.output}`);
    return;
  }
  process.stdout.write(rendered);
}

export function parseConversationPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  return port;
}
