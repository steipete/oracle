import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatGptProEvent } from "../../src/browser/providers/chatgptProVerification.js";
import type { GeminiDeepThinkEvent } from "../../src/browser/providers/geminiDeepThink_verification.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FIXTURE_SESSION_HASH = `sha256:${"1".repeat(64)}` as const;
export const FIXTURE_PROMPT_HASH = `sha256:${"2".repeat(64)}` as const;
export const FIXTURE_OUTPUT_HASH = `sha256:${"3".repeat(64)}` as const;

export type BrowserFixtureProvider = "chatgpt" | "gemini";

export interface BrowserFixtureElement {
  readonly role: string;
  readonly text: string;
  readonly selected: boolean;
  readonly attrs: Readonly<Record<string, string>>;
}

export interface BrowserFixtureSnapshot {
  readonly provider: BrowserFixtureProvider;
  readonly name: string;
  readonly html: string;
  readonly elements: readonly BrowserFixtureElement[];
  readonly coverage: readonly string[];
}

export interface ChatGptFixtureModeProbe {
  readonly modelLabel: string;
  readonly effortLabels: readonly string[];
  readonly selectedEffortLabel: string | null;
}

export interface GeminiFixtureModeProbe {
  readonly modelLabel: string;
  readonly deepThinkLabel: string;
  readonly observedThinkingLevelLabels: readonly string[];
  readonly selectedThinkingLevel: string | null;
  readonly thinkingLevelControlExposed: boolean;
}

export async function loadBrowserFixture(
  provider: BrowserFixtureProvider,
  name: string,
): Promise<BrowserFixtureSnapshot> {
  const html = await readFile(
    path.join(TEST_ROOT, "browser", "fixtures", provider, `${name}.html`),
    "utf8",
  );
  return {
    provider,
    name,
    html,
    elements: extractFixtureElements(html),
    coverage: extractCoverageTags(html),
  };
}

export function extractChatGptModeProbe(
  snapshot: BrowserFixtureSnapshot,
): ChatGptFixtureModeProbe {
  const model = selectedElement(snapshot, "chatgpt-model-option");
  const efforts = elementsByRole(snapshot, "chatgpt-effort-option");
  return {
    modelLabel: model?.text ?? "",
    effortLabels: efforts.map((element) => element.text),
    selectedEffortLabel: efforts.find((element) => element.selected)?.text ?? null,
  };
}

export function extractGeminiModeProbe(
  snapshot: BrowserFixtureSnapshot,
): GeminiFixtureModeProbe {
  const model = selectedElement(snapshot, "gemini-model-option");
  const selectedDeepThink = selectedElement(snapshot, "gemini-deep-think-option");
  const selectedNonDeepThink = selectedElement(snapshot, "gemini-tool-option");
  const thinkingLevels = elementsByRole(snapshot, "gemini-thinking-level-option");
  return {
    modelLabel: model?.text ?? "",
    deepThinkLabel: selectedDeepThink?.text ?? selectedNonDeepThink?.text ?? "",
    observedThinkingLevelLabels: thinkingLevels.map((element) => element.text),
    selectedThinkingLevel: thinkingLevels.find((element) => element.selected)?.text ?? null,
    thinkingLevelControlExposed:
      thinkingLevels.length > 0 ||
      snapshot.html.includes('data-thinking-level-control="exposed"'),
  };
}

export function chatGptEventsFromFixture(
  probe: ChatGptFixtureModeProbe,
  options: { includePromptRun?: boolean } = {},
): readonly ChatGptProEvent[] {
  const events: ChatGptProEvent[] = [
    { type: "browser_connected", mode: "remote" },
    { type: "login_verified" },
    { type: "model_menu_opened" },
    { type: "pro_candidate_selected", modelLabel: probe.modelLabel },
    { type: "effort_candidate_selected", observedEffortLabels: probe.effortLabels },
    { type: "mode_verified_same_session", sessionIdHash: FIXTURE_SESSION_HASH },
  ];
  if (options.includePromptRun) {
    events.push(
      { type: "submit_prompt", promptSha256: FIXTURE_PROMPT_HASH },
      { type: "response_arrived", outputTextSha256: FIXTURE_OUTPUT_HASH, bytesLength: 2048 },
      { type: "evidence_written", evidenceId: "fixture-chatgpt-evidence" },
      { type: "finish" },
    );
  }
  return events;
}

export function geminiEventsFromFixture(
  probe: GeminiFixtureModeProbe,
  options: { includePromptRun?: boolean } = {},
): readonly GeminiDeepThinkEvent[] {
  const events: GeminiDeepThinkEvent[] = [
    { type: "browser_connected", mode: "remote" },
    { type: "login_verified" },
    { type: "gemini_model_candidate_selected", modelLabel: probe.modelLabel },
    { type: "deep_think_menu_opened" },
    {
      type: "deep_think_candidate_selected",
      deepThinkLabel: probe.deepThinkLabel,
      observedThinkingLevelLabels: probe.observedThinkingLevelLabels,
      selectedThinkingLevel: probe.selectedThinkingLevel,
      thinkingLevelControlExposed: probe.thinkingLevelControlExposed,
    },
    {
      type: "deep_think_verified_same_session",
      sessionIdHash: FIXTURE_SESSION_HASH,
      verifiedAt: "2026-05-13T00:00:00.000Z",
    },
  ];
  if (options.includePromptRun) {
    events.push(
      {
        type: "submit_prompt",
        promptSha256: FIXTURE_PROMPT_HASH,
        submittedAt: "2026-05-13T00:00:05.000Z",
      },
      { type: "response_stream_started" },
      {
        type: "response_arrived",
        outputTextSha256: FIXTURE_OUTPUT_HASH,
        bytesLength: 4096,
        capturedAt: "2026-05-13T00:00:08.000Z",
      },
      {
        type: "evidence_written",
        evidenceId: "fixture-gemini-evidence",
        writtenAt: "2026-05-13T00:00:09.000Z",
      },
      { type: "finish" },
    );
  }
  return events;
}

function extractFixtureElements(html: string): BrowserFixtureElement[] {
  const elements: BrowserFixtureElement[] = [];
  const tagPattern =
    /<([a-z][a-z0-9-]*)\b(?=[^>]*\bdata-oracle-role=)([^>]*)>([\s\S]*?)<\/\1>/giu;
  for (const match of html.matchAll(tagPattern)) {
    const attrs = parseAttrs(match[2] ?? "");
    const role = attrs["data-oracle-role"];
    if (!role) continue;
    elements.push({
      role,
      text: normalizeText(stripTags(match[3] ?? "")),
      selected: isSelected(attrs),
      attrs,
    });
  }
  return elements;
}

function extractCoverageTags(html: string): string[] {
  return [...html.matchAll(/data-requirement="([^"]+)"/gu)].map((match) => match[1]);
}

function elementsByRole(
  snapshot: BrowserFixtureSnapshot,
  role: string,
): readonly BrowserFixtureElement[] {
  return snapshot.elements.filter((element) => element.role === role);
}

function selectedElement(
  snapshot: BrowserFixtureSnapshot,
  role: string,
): BrowserFixtureElement | null {
  return elementsByRole(snapshot, role).find((element) => element.selected) ?? null;
}

function parseAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of input.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/gu)) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[2]);
  }
  return attrs;
}

function isSelected(attrs: Readonly<Record<string, string>>): boolean {
  return [
    attrs["data-selected"],
    attrs["aria-selected"],
    attrs["aria-checked"],
    attrs["aria-pressed"],
  ].some((value) => value?.toLowerCase() === "true");
}

function stripTags(input: string): string {
  return decodeHtml(input.replace(/<[^>]+>/gu, " "));
}

function normalizeText(input: string): string {
  return input.replace(/\s+/gu, " ").trim();
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}
