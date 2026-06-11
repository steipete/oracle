import { formatFileSections } from "./markdown.js";

export interface PromptFileSection {
  displayPath: string;
  content: string;
}

/**
 * Build the shared markdown structure for system/user/file sections.
 * Collapses excessive blank lines and trims trailing whitespace to keep
 * snapshots stable across CLI and browser modes.
 */
export function buildPromptMarkdown(
  systemPrompt: string,
  userPrompt: string,
  sections: PromptFileSection[],
): string {
  const lines = ["[SYSTEM]", systemPrompt, "", "[USER]", userPrompt, ""];
  lines.push(formatFileSections(sections, { trailingNewline: true }));
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
