import { InvalidArgumentError, type Command } from "commander";
import { parseDuration } from "../duration.js";
import path from "node:path";
import fg from "fast-glob";
import type { ModelName, PreviewMode } from "../oracle.js";
import { DEFAULT_MODEL, MODEL_CONFIGS } from "../oracle/config.js";

export function collectPaths(
  value: string | string[] | undefined,
  previous: string[] = [],
): string[] {
  if (!value) {
    return previous;
  }
  const nextValues = Array.isArray(value) ? value : [value];
  return previous.concat(
    nextValues
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/**
 * Merge all path-like CLI inputs (file/include aliases) into a single list, preserving order.
 */
export function mergePathLikeOptions(
  file?: string[],
  include?: string[],
  filesAlias?: string[],
  pathAlias?: string[],
  pathsAlias?: string[],
): string[] {
  const withFile = collectPaths(file, []);
  const withInclude = collectPaths(include, withFile);
  const withFilesAlias = collectPaths(filesAlias, withInclude);
  const withPathAlias = collectPaths(pathAlias, withFilesAlias);
  return collectPaths(pathsAlias, withPathAlias);
}

export function dedupePathInputs(
  inputs: string[],
  { cwd = process.cwd() }: { cwd?: string } = {},
): { deduped: string[]; duplicates: string[] } {
  const deduped: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const entry of inputs ?? []) {
    const raw = entry?.trim();
    if (!raw) continue;

    let key = raw;
    if (!raw.startsWith("!") && !fg.isDynamicPattern(raw)) {
      const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      key = `path:${path.normalize(absolute)}`;
    } else {
      key = `pattern:${raw}`;
    }

    if (seen.has(key)) {
      duplicates.push(raw);
      continue;
    }
    seen.add(key);
    deduped.push(raw);
  }

  return { deduped, duplicates };
}

export function collectModelList(value: string, previous: string[] = []): string[] {
  if (!value) {
    return previous;
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return previous.concat(entries);
}

export function collectTextValues(value: string, previous: string[] = []): string[] {
  const trimmed = value.trim();
  return trimmed ? previous.concat(trimmed) : previous;
}

export function parseFloatOption(value: string): number {
  const parsed = parseStrictNumber(value);
  if (parsed === undefined) {
    throw new InvalidArgumentError("Value must be a number.");
  }
  return parsed;
}

export function parseIntOption(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = parseStrictInteger(value);
  if (parsed === undefined) {
    throw new InvalidArgumentError("Value must be an integer.");
  }
  return parsed;
}

export function parseHeartbeatOption(value: string | number | undefined): number {
  if (value == null) {
    return 30;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value) || value < 0) {
      throw new InvalidArgumentError("Heartbeat interval must be zero or a positive number.");
    }
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return 30;
  }
  if (normalized === "false" || normalized === "off") {
    return 0;
  }
  const parsed = parseStrictNumber(normalized);
  if (parsed === undefined || parsed < 0) {
    throw new InvalidArgumentError("Heartbeat interval must be zero or a positive number.");
  }
  return parsed;
}

export function usesDefaultStatusFilters(cmd: Command): boolean {
  const hoursSource = cmd.getOptionValueSource?.("hours") ?? "default";
  const limitSource = cmd.getOptionValueSource?.("limit") ?? "default";
  const allSource = cmd.getOptionValueSource?.("all") ?? "default";
  return hoursSource === "default" && limitSource === "default" && allSource === "default";
}

export function resolvePreviewMode(value: boolean | string | undefined): PreviewMode | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value as PreviewMode;
  }
  if (value === true) {
    return "summary";
  }
  return undefined;
}

export function parseSearchOption(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "0", "no"].includes(normalized)) {
    return false;
  }
  throw new InvalidArgumentError('Search mode must be "on" or "off".');
}

export function normalizeModelOption(value: string | undefined): string {
  return (value ?? "").trim();
}

export function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

export function parseTimeoutOption(value: string | undefined): number | "auto" | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    const parsed = Number.parseFloat(normalized);
    if (parsed > 0) {
      return parsed;
    }
  }
  const parsedMs = parseDuration(normalized, Number.NaN);
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) {
    throw new InvalidArgumentError(
      'Timeout must be a positive number of seconds, a duration like "10m", or "auto".',
    );
  }
  return parsedMs / 1000;
}

export function parseToonPassthroughOption(value: string | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return ["true", "1", "yes", "on", "passthrough"].includes(normalized);
}

function parseStrictInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseStrictNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseDurationOption(value: string | undefined, label: string): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidArgumentError(`${label} must be a duration like 30m, 10s, 500ms, or 2h.`);
  }
  const parsed = parseDuration(trimmed, Number.NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(
      `${label} must be a positive duration like 30m, 10s, 500ms, or 2h.`,
    );
  }
  return parsed;
}

export const CHATGPT_PRO_BROWSER_MODEL = "chatgpt-pro-latest" as const;
export const CHATGPT_PRO_REMOTE_BROWSER_MODES = ["preferred", "required", "off"] as const;
export const CHATGPT_PRO_EVIDENCE_MODES = ["redacted"] as const;

export type ChatGptProBrowserModel = typeof CHATGPT_PRO_BROWSER_MODEL;
export type ChatGptProRemoteBrowserMode = (typeof CHATGPT_PRO_REMOTE_BROWSER_MODES)[number];
export type ChatGptProEvidenceMode = (typeof CHATGPT_PRO_EVIDENCE_MODES)[number];

export function parseChatGptProRemoteBrowserOption(
  value: string | undefined,
): ChatGptProRemoteBrowserMode {
  const normalized = normalizeChoice(value, "preferred");
  if (isOneOf(normalized, CHATGPT_PRO_REMOTE_BROWSER_MODES)) {
    return normalized;
  }
  throw new InvalidArgumentError('Remote browser mode must be "preferred", "required", or "off".');
}

export function parseChatGptProEvidenceOption(value: string | undefined): ChatGptProEvidenceMode {
  const normalized = normalizeChoice(value, "redacted");
  if (isOneOf(normalized, CHATGPT_PRO_EVIDENCE_MODES)) {
    return normalized;
  }
  throw new InvalidArgumentError(
    'ChatGPT Pro evidence mode must be "redacted"; raw evidence is not allowed on this protected route.',
  );
}

export function normalizeChatGptProModelOption(value: string | undefined): ChatGptProBrowserModel {
  const normalized = normalizeChoice(value, CHATGPT_PRO_BROWSER_MODEL);
  if (isChatGptProModelAlias(normalized)) {
    return CHATGPT_PRO_BROWSER_MODEL;
  }
  throw new InvalidArgumentError(
    `ChatGPT Pro route cannot be downgraded with --model ${JSON.stringify(value)}. Use --model ${CHATGPT_PRO_BROWSER_MODEL} or a GPT Pro browser alias.`,
  );
}

export function isChatGptProModelAlias(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  const collapsed = normalized.replace(/[\s_]+/gu, "-");
  if (
    collapsed === CHATGPT_PRO_BROWSER_MODEL ||
    collapsed === "chatgpt-pro" ||
    collapsed === "pro"
  ) {
    return true;
  }
  return collapsed.startsWith("gpt-5") && collapsed.includes("pro") && !collapsed.includes("codex");
}

export const GEMINI_DEEP_THINK_BROWSER_MODEL = "gemini-3.1-pro-deep-think" as const;
export const GEMINI_DEEP_THINK_REMOTE_BROWSER_MODES = ["preferred", "required", "off"] as const;
export const GEMINI_DEEP_THINK_EVIDENCE_MODES = ["redacted"] as const;
export const GEMINI_DEEP_THINK_FALLBACK_MODES = ["fail"] as const;

export type GeminiDeepThinkBrowserModel = typeof GEMINI_DEEP_THINK_BROWSER_MODEL;
export type GeminiDeepThinkRemoteBrowserMode =
  (typeof GEMINI_DEEP_THINK_REMOTE_BROWSER_MODES)[number];
export type GeminiDeepThinkEvidenceMode = (typeof GEMINI_DEEP_THINK_EVIDENCE_MODES)[number];
export type GeminiDeepThinkFallbackMode = (typeof GEMINI_DEEP_THINK_FALLBACK_MODES)[number];

export function parseGeminiDeepThinkRemoteBrowserOption(
  value: string | undefined,
): GeminiDeepThinkRemoteBrowserMode {
  const normalized = normalizeChoice(value, "preferred");
  if (isOneOf(normalized, GEMINI_DEEP_THINK_REMOTE_BROWSER_MODES)) {
    return normalized;
  }
  throw new InvalidArgumentError('Remote browser mode must be "preferred", "required", or "off".');
}

export function parseGeminiDeepThinkEvidenceOption(
  value: string | undefined,
): GeminiDeepThinkEvidenceMode {
  const normalized = normalizeChoice(value, "redacted");
  if (isOneOf(normalized, GEMINI_DEEP_THINK_EVIDENCE_MODES)) {
    return normalized;
  }
  throw new InvalidArgumentError(
    'Gemini Deep Think evidence mode must be "redacted"; raw evidence is not allowed on this protected route.',
  );
}

export function parseGeminiDeepThinkFallbackOption(
  value: string | undefined,
): GeminiDeepThinkFallbackMode {
  const normalized = normalizeChoice(value, "fail");
  if (isOneOf(normalized, GEMINI_DEEP_THINK_FALLBACK_MODES)) {
    return normalized;
  }
  throw new InvalidArgumentError(
    'Gemini Deep Think fallback must be "fail"; this protected route cannot silently downgrade.',
  );
}

export function normalizeGeminiDeepThinkModelOption(
  value: string | undefined,
): GeminiDeepThinkBrowserModel {
  const normalized = normalizeChoice(value, GEMINI_DEEP_THINK_BROWSER_MODEL);
  if (isGeminiDeepThinkModelAlias(normalized)) {
    return GEMINI_DEEP_THINK_BROWSER_MODEL;
  }
  if (normalized.includes("gemini")) {
    throw new InvalidArgumentError(
      `Gemini Deep Think route cannot use API/substitute model ${JSON.stringify(value)}. Use --model ${GEMINI_DEEP_THINK_BROWSER_MODEL}.`,
    );
  }
  throw new InvalidArgumentError(
    `Gemini Deep Think route requires --model ${GEMINI_DEEP_THINK_BROWSER_MODEL} or a Deep Think browser alias.`,
  );
}

export function isGeminiDeepThinkModelAlias(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  const collapsed = normalized.replace(/[\s_]+/gu, "-");
  return (
    collapsed === GEMINI_DEEP_THINK_BROWSER_MODEL ||
    collapsed === "gemini-3-pro-deep-think" ||
    collapsed === "gemini-3-pro-deepthink" ||
    collapsed === "gemini-3-deep-think" ||
    collapsed === "gemini-deep-think" ||
    collapsed === "deep-think"
  );
}

function normalizeChoice(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || fallback;
}

function isOneOf<const T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return (allowed as readonly string[]).includes(value);
}

const V18_WORKFLOW_PROVIDER_SLOTS = [
  "chatgpt_pro_first_plan",
  "chatgpt_pro_synthesis",
  "claude_code_opus",
  "codex_intake",
  "codex_thinking_fast_draft",
  "deepseek_v4_pro_reasoning_search",
  "gemini_deep_think",
  "xai_grok_reasoning",
] as const;

const V18_WORKFLOW_PROVIDER_SLOT_SET: ReadonlySet<string> = new Set(V18_WORKFLOW_PROVIDER_SLOTS);

function normalizeWorkflowProviderSlotCandidate(value: string): string {
  return value.trim().toLowerCase().replace(/-+/gu, "_");
}

export function isWorkflowProviderSlotName(value: string | undefined): boolean {
  if (!value) return false;
  return V18_WORKFLOW_PROVIDER_SLOT_SET.has(normalizeWorkflowProviderSlotCandidate(value));
}

function assertNotWorkflowProviderSlotModel(value: string): void {
  if (!isWorkflowProviderSlotName(value)) return;
  const slot = normalizeWorkflowProviderSlotCandidate(value);
  throw new InvalidArgumentError(
    `v18 provider slot "${slot}" is not a model name. Oracle will not satisfy workflow slots by substituting a direct API model; pass a concrete --model value or route provider-slot metadata through the v18 workflow policy layer.`,
  );
}

function isGeminiDeepThinkAlias(normalized: string): boolean {
  return (
    (normalized.includes("gemini") && normalized.includes("deep")) ||
    normalized.includes("deep-think") ||
    normalized.includes("deep_think") ||
    normalized.includes("deepthink")
  );
}

export function resolveApiModel(modelValue: string): ModelName {
  const normalized = normalizeModelOption(modelValue).toLowerCase();
  assertNotWorkflowProviderSlotModel(normalized);
  if (normalized in MODEL_CONFIGS) {
    return normalized as ModelName;
  }
  if (normalized.includes("/")) {
    return normalized as ModelName;
  }
  if (normalized.includes("grok")) {
    return "grok-4.1";
  }
  if (normalized.includes("claude") && normalized.includes("sonnet")) {
    return "claude-4.6-sonnet";
  }
  if (normalized.includes("claude") && normalized.includes("opus")) {
    return "claude-4.1-opus";
  }
  if (normalized.includes("5.5") && normalized.includes("pro")) {
    return "gpt-5.5-pro";
  }
  if (normalized.includes("5.5")) {
    return "gpt-5.5";
  }
  if (normalized.includes("5.4") && normalized.includes("pro")) {
    return "gpt-5.4-pro";
  }
  if (normalized.includes("5.4")) {
    return "gpt-5.4";
  }
  if (normalized === "claude" || normalized === "sonnet" || /(^|\b)sonnet(\b|$)/.test(normalized)) {
    return "claude-4.6-sonnet";
  }
  if (normalized === "opus" || normalized === "claude-4.1") {
    return "claude-4.1-opus";
  }
  if (normalized.includes("5.0") || normalized === "gpt-5-pro" || normalized === "gpt-5") {
    return "gpt-5-pro";
  }
  if (normalized.includes("5-pro") && !normalized.includes("5.1")) {
    return "gpt-5-pro";
  }
  if (normalized.includes("5.2") && normalized.includes("pro")) {
    return "gpt-5.2-pro";
  }
  if (normalized.includes("5.1") && normalized.includes("pro")) {
    return "gpt-5.1-pro";
  }
  if (normalized.includes("codex")) {
    if (normalized.includes("max")) {
      throw new InvalidArgumentError(
        "gpt-5.1-codex-max is not available yet. OpenAI has not released the API.",
      );
    }
    return "gpt-5.1-codex";
  }
  if (isGeminiDeepThinkAlias(normalized)) {
    throw new InvalidArgumentError(
      "Gemini Deep Think is browser-only today. Use --engine browser --model gemini-3-deep-think.",
    );
  }
  if (normalized.includes("gemini")) {
    if (normalized.includes("3.1") || normalized.includes("3_1")) {
      return "gemini-3.1-pro";
    }
    return "gemini-3-pro";
  }
  if (normalized.includes("pro")) {
    return DEFAULT_MODEL;
  }
  // Passthrough for custom/OpenRouter model IDs.
  return normalized as ModelName;
}

export function inferModelFromLabel(modelValue: string): ModelName {
  const normalized = normalizeModelOption(modelValue).toLowerCase();
  if (!normalized) {
    return DEFAULT_MODEL;
  }
  assertNotWorkflowProviderSlotModel(normalized);
  if (normalized in MODEL_CONFIGS) {
    return normalized as ModelName;
  }
  if (normalized.includes("/")) {
    return normalized as ModelName;
  }
  if (normalized.includes("grok")) {
    return "grok-4.1";
  }
  if (normalized.includes("claude") && normalized.includes("sonnet")) {
    return "claude-4.6-sonnet";
  }
  if (normalized.includes("claude") && normalized.includes("opus")) {
    return "claude-4.1-opus";
  }
  if (normalized.includes("codex")) {
    return "gpt-5.1-codex";
  }
  if (isGeminiDeepThinkAlias(normalized)) {
    return "gemini-3-pro-deep-think" as ModelName;
  }
  if (normalized.includes("gemini")) {
    if (normalized.includes("3.1") || normalized.includes("3_1")) {
      return "gemini-3.1-pro";
    }
    return "gemini-3-pro";
  }
  if (normalized.includes("classic")) {
    return "gpt-5-pro";
  }
  if (normalized.includes("thinking") && normalized.includes("heavy")) {
    return "gpt-5.5";
  }
  if ((normalized.includes("5.5") || normalized.includes("5_5")) && normalized.includes("pro")) {
    return "gpt-5.5-pro";
  }
  if (
    (normalized.includes("5.5") || normalized.includes("5_5")) &&
    (normalized.includes("instant") || normalized.includes("fast"))
  ) {
    return "gpt-5.5-instant";
  }
  if (normalized.includes("5.5") || normalized.includes("5_5")) {
    return "gpt-5.5";
  }
  if ((normalized.includes("5.4") || normalized.includes("5_4")) && normalized.includes("pro")) {
    return "gpt-5.4-pro";
  }
  if (normalized.includes("5.4") || normalized.includes("5_4")) {
    return "gpt-5.4";
  }
  if ((normalized.includes("5.2") || normalized.includes("5_2")) && normalized.includes("pro")) {
    return "gpt-5.2-pro";
  }
  // Browser-only: pass through 5.2 thinking/instant variants for browser label mapping
  if (
    (normalized.includes("5.2") || normalized.includes("5_2")) &&
    normalized.includes("thinking")
  ) {
    return "gpt-5.2-thinking" as ModelName;
  }
  if (
    (normalized.includes("5.2") || normalized.includes("5_2")) &&
    normalized.includes("instant")
  ) {
    return "gpt-5.2-instant";
  }
  if (normalized.includes("5.0") || normalized.includes("5-pro")) {
    return "gpt-5-pro";
  }
  if (
    normalized.includes("gpt-5") &&
    normalized.includes("pro") &&
    !normalized.includes("5.1") &&
    !normalized.includes("5.2") &&
    !normalized.includes("5.5") &&
    !normalized.includes("5.4")
  ) {
    return "gpt-5-pro";
  }
  if ((normalized.includes("5.1") || normalized.includes("5_1")) && normalized.includes("pro")) {
    return "gpt-5.1-pro";
  }
  if (normalized.includes("pro")) {
    return DEFAULT_MODEL;
  }
  if (normalized.includes("5.1") || normalized.includes("5_1")) {
    return "gpt-5.1";
  }
  if (normalized.includes("thinking")) {
    return "gpt-5.2-thinking" as ModelName;
  }
  if (normalized.includes("instant") || normalized.includes("fast")) {
    return "gpt-5.2-instant";
  }
  return "gpt-5.2";
}
