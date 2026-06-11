import chalk from "chalk";
import type { FileContent, FileTokenStats, TokenizerFn } from "./types.js";
import { createFileSections } from "./files.js";
import { formatFileSections } from "./markdown.js";

export function getFileTokenStats(
  files: FileContent[],
  {
    cwd = process.cwd(),
    tokenizer,
    tokenizerOptions,
    inputTokenBudget,
  }: {
    cwd?: string;
    tokenizer: TokenizerFn;
    tokenizerOptions: Record<string, unknown>;
    inputTokenBudget?: number;
  },
): FileTokenStats {
  if (!files.length) {
    return { stats: [], totalTokens: 0 };
  }
  const sections = createFileSections(files, cwd);
  const stats = sections
    .map((section) => {
      const sectionText = formatFileSections([section], {
        includeFileIndex: true,
      }).trimEnd();
      const tokens = tokenizer(sectionText, tokenizerOptions);
      const percent = inputTokenBudget ? (tokens / inputTokenBudget) * 100 : undefined;
      return {
        path: section.absolutePath,
        displayPath: section.displayPath,
        tokens,
        percent,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
  const totalTokens = stats.reduce((sum, entry) => sum + entry.tokens, 0);
  return { stats, totalTokens };
}

export function printFileTokenStats(
  { stats, totalTokens }: FileTokenStats,
  {
    inputTokenBudget,
    log = console.log,
  }: { inputTokenBudget?: number; log?: (message: string) => void },
): void {
  if (!stats.length) {
    return;
  }
  log(chalk.bold("File Token Usage"));
  for (const entry of stats) {
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
