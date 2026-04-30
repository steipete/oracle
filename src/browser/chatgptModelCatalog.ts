import type { ModelName } from "../oracle/types.js";

export type ChatGptBrowserModelVersion = "5-5" | "5-4" | "5-2" | "5-1" | "5-0";
export type ChatGptBrowserModelKind = "pro" | "thinking" | "instant" | null;

export interface ChatGptVisibleAlias {
  includes: string[];
  excludes?: string[];
}

export interface ChatGptBrowserModelTarget {
  model: ModelName;
  label: string;
  version: ChatGptBrowserModelVersion;
  kind: ChatGptBrowserModelKind;
  visibleAliases?: ChatGptVisibleAlias[];
}

export interface ChatGptVersionPattern {
  version: ChatGptBrowserModelVersion;
  textTokens: string[];
  testIdTokens: string[];
}

export interface ChatGptModelMatchers {
  labelTokens: string[];
  testIdTokens: string[];
  targetVersion: ChatGptBrowserModelVersion | null;
  targetKind: ChatGptBrowserModelKind;
  visibleAliases: ChatGptVisibleAlias[];
  versionPatterns: ChatGptVersionPattern[];
}

export const LATEST_CHATGPT_BROWSER_PRO_MODEL = "gpt-5.5-pro" as const;
export const DEFAULT_CHATGPT_BROWSER_MODEL_LABEL = "GPT-5.5 Pro";

const CHATGPT_BROWSER_MODEL_TARGETS: ChatGptBrowserModelTarget[] = [
  {
    model: "gpt-5.5-pro",
    label: DEFAULT_CHATGPT_BROWSER_MODEL_LABEL,
    version: "5-5",
    kind: "pro",
    visibleAliases: [{ includes: ["pro", "extended"], excludes: ["thinking"] }],
  },
  {
    model: "gpt-5.5",
    label: "Thinking 5.5",
    version: "5-5",
    kind: "thinking",
    visibleAliases: [{ includes: ["thinking", "heavy"], excludes: ["pro"] }],
  },
  { model: "gpt-5.4-pro", label: "GPT-5.4 Pro", version: "5-4", kind: "pro" },
  { model: "gpt-5.4", label: "Thinking 5.4", version: "5-4", kind: "thinking" },
  { model: "gpt-5.2-pro", label: "GPT-5.2 Pro", version: "5-2", kind: "pro" },
  { model: "gpt-5.2-thinking", label: "GPT-5.2 Thinking", version: "5-2", kind: "thinking" },
  { model: "gpt-5.2-instant", label: "GPT-5.2 Instant", version: "5-2", kind: "instant" },
  { model: "gpt-5.2", label: "GPT-5.2", version: "5-2", kind: null },
  { model: "gpt-5.1-pro", label: "GPT-5.1 Pro", version: "5-1", kind: "pro" },
  { model: "gpt-5.1", label: "GPT-5.1", version: "5-1", kind: null },
  { model: "gpt-5-pro", label: "GPT-5 Pro", version: "5-0", kind: "pro" },
];

const CHATGPT_BROWSER_ALIASES = new Map<string, ModelName>([
  ["gpt-5-pro", LATEST_CHATGPT_BROWSER_PRO_MODEL],
  ["gpt-5.1-pro", LATEST_CHATGPT_BROWSER_PRO_MODEL],
  ["gpt-5.2-pro", LATEST_CHATGPT_BROWSER_PRO_MODEL],
  ["gpt-5.1", "gpt-5.2"],
]);

export const CHATGPT_BROWSER_VERSION_PATTERNS: ChatGptVersionPattern[] = [
  {
    version: "5-5",
    textTokens: ["5 5", "gpt55"],
    testIdTokens: ["5-5", "5.5", "gpt-5-5", "gpt-5.5", "gpt55"],
  },
  {
    version: "5-4",
    textTokens: ["5 4", "gpt54"],
    testIdTokens: ["5-4", "5.4", "gpt-5-4", "gpt-5.4", "gpt54"],
  },
  {
    version: "5-2",
    textTokens: ["5 2", "gpt52"],
    testIdTokens: ["5-2", "5.2", "gpt-5-2", "gpt-5.2", "gpt52"],
  },
  {
    version: "5-1",
    textTokens: ["5 1", "gpt51"],
    testIdTokens: ["5-1", "5.1", "gpt-5-1", "gpt-5.1", "gpt51"],
  },
  {
    version: "5-0",
    textTokens: ["5 0", "gpt50", "gpt 5 pro", "gpt 5"],
    testIdTokens: ["5-0", "5.0", "gpt-5-0", "gpt-5.0", "gpt50"],
  },
];

export function isChatGptModelForBrowser(model: ModelName): boolean {
  const normalized = model.toLowerCase();
  return normalized.startsWith("gpt-") && !normalized.includes("codex");
}

export function normalizeChatGptBrowserModelForBrowser(model: ModelName): ModelName {
  const normalized = model.toLowerCase() as ModelName;
  if (!isChatGptModelForBrowser(normalized)) {
    return model;
  }
  return (
    CHATGPT_BROWSER_ALIASES.get(normalized) ?? getChatGptBrowserTarget(normalized)?.model ?? model
  );
}

export function mapChatGptModelToBrowserLabel(model: ModelName): string | undefined {
  const normalized = normalizeChatGptBrowserModelForBrowser(model);
  return getChatGptBrowserTarget(normalized)?.label;
}

export function inferChatGptBrowserModelFromLabel(label: string): ModelName | undefined {
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (getChatGptBrowserTarget(normalized)) {
    return normalized as ModelName;
  }

  const version = inferVersionFromText(normalized);
  const kind = inferKindFromText(normalized);
  if (version === "5-5") {
    return kind === "pro" ? "gpt-5.5-pro" : "gpt-5.5";
  }
  if (version === "5-4") {
    return kind === "pro" ? "gpt-5.4-pro" : "gpt-5.4";
  }
  if (version === "5-2") {
    if (kind === "pro") return "gpt-5.2-pro";
    if (kind === "thinking") return "gpt-5.2-thinking";
    if (kind === "instant") return "gpt-5.2-instant";
    return "gpt-5.2";
  }
  if (version === "5-1") {
    return kind === "pro" ? "gpt-5.1-pro" : "gpt-5.1";
  }
  if (version === "5-0") {
    return "gpt-5-pro";
  }
  if (kind === "pro") {
    return LATEST_CHATGPT_BROWSER_PRO_MODEL;
  }
  if (kind === "thinking") {
    return "gpt-5.2-thinking";
  }
  if (kind === "instant") {
    return "gpt-5.2-instant";
  }
  return undefined;
}

export function buildChatGptModelMatchers(targetModel: string): ChatGptModelMatchers {
  const base = targetModel.trim().toLowerCase();
  const inferredModel = inferChatGptBrowserModelFromLabel(base);
  const target = inferredModel ? getChatGptBrowserTarget(inferredModel) : undefined;
  const targetVersion = inferVersionFromText(base) ?? target?.version ?? null;
  const targetKind = inferKindFromText(base) ?? target?.kind ?? null;
  const labelTokens = new Set<string>();
  const testIdTokens = new Set<string>();

  const push = (value: string | null | undefined, set: Set<string>) => {
    const normalized = value?.trim();
    if (normalized) {
      set.add(normalized);
    }
  };

  push(base, labelTokens);
  push(base.replace(/\s+/g, " "), labelTokens);
  const collapsed = base.replace(/\s+/g, "");
  push(collapsed, labelTokens);
  const dotless = base.replace(/[.]/g, "");
  push(dotless, labelTokens);
  push(`chatgpt ${base}`, labelTokens);
  push(`chatgpt ${dotless}`, labelTokens);
  push(`gpt ${base}`, labelTokens);
  push(`gpt ${dotless}`, labelTokens);

  if (targetVersion) {
    addVersionMatcherTokens(targetVersion, labelTokens, testIdTokens);
  }

  if (targetKind === "thinking") {
    push("thinking", labelTokens);
    if (targetVersion === "5-5") {
      push("thinking heavy", labelTokens);
      push("heavy thinking", labelTokens);
    }
    addKindTestIdTokens(targetVersion, "thinking", testIdTokens);
  }

  if (targetKind === "instant") {
    push("instant", labelTokens);
    addKindTestIdTokens(targetVersion, "instant", testIdTokens);
  }

  if (targetKind === "pro") {
    push("proresearch", labelTokens);
    push("research grade", labelTokens);
    push("advanced reasoning", labelTokens);
    if (targetVersion === "5-5") {
      push("pro extended", labelTokens);
      push("extended pro", labelTokens);
    }
    addKindTestIdTokens(targetVersion, "pro", testIdTokens);
    testIdTokens.add("pro");
    testIdTokens.add("proresearch");
  }

  if (targetVersion && !targetKind) {
    addBaseModelTestIdToken(targetVersion, testIdTokens);
  }

  base
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      push(token, labelTokens);
    });

  const hyphenated = base.replace(/\s+/g, "-");
  push(hyphenated, testIdTokens);
  push(collapsed, testIdTokens);
  push(dotless, testIdTokens);
  push(`model-switcher-${hyphenated}`, testIdTokens);
  push(`model-switcher-${collapsed}`, testIdTokens);
  push(`model-switcher-${dotless}`, testIdTokens);

  if (!labelTokens.size) {
    labelTokens.add(base);
  }
  if (!testIdTokens.size) {
    testIdTokens.add(base.replace(/\s+/g, "-"));
  }

  return {
    labelTokens: Array.from(labelTokens).filter(Boolean),
    testIdTokens: Array.from(testIdTokens).filter(Boolean),
    targetVersion,
    targetKind,
    visibleAliases: target?.visibleAliases ?? visibleAliasesFor(targetVersion, targetKind),
    versionPatterns: CHATGPT_BROWSER_VERSION_PATTERNS,
  };
}

export function getChatGptModelKindTestIdTokens(): Record<"pro" | "thinking", string[]> {
  const tokens = {
    pro: new Set<string>(["-pro-"]),
    thinking: new Set<string>(["-thinking-thinking-effort"]),
  };
  for (const target of CHATGPT_BROWSER_MODEL_TARGETS) {
    if (target.kind !== "pro" && target.kind !== "thinking") {
      continue;
    }
    addKindTestIdTokens(target.version, target.kind, tokens[target.kind]);
  }
  return {
    pro: Array.from(tokens.pro),
    thinking: Array.from(tokens.thinking),
  };
}

function getChatGptBrowserTarget(model: ModelName): ChatGptBrowserModelTarget | undefined {
  const normalized = model.toLowerCase();
  return CHATGPT_BROWSER_MODEL_TARGETS.find((target) => target.model === normalized);
}

function inferVersionFromText(value: string): ChatGptBrowserModelVersion | null {
  const normalized = value.replace(/_/g, ".").replace(/\s+/g, " ");
  if (/(^|[^0-9])5[.\-\s]?5([^0-9]|$)/.test(normalized) || normalized.includes("gpt55")) {
    return "5-5";
  }
  if (/(^|[^0-9])5[.\-\s]?4([^0-9]|$)/.test(normalized) || normalized.includes("gpt54")) {
    return "5-4";
  }
  if (/(^|[^0-9])5[.\-\s]?2([^0-9]|$)/.test(normalized) || normalized.includes("gpt52")) {
    return "5-2";
  }
  if (/(^|[^0-9])5[.\-\s]?1([^0-9]|$)/.test(normalized) || normalized.includes("gpt51")) {
    return "5-1";
  }
  if (
    /(^|[^0-9])5[.\-\s]?0([^0-9]|$)/.test(normalized) ||
    normalized.includes("gpt50") ||
    normalized.includes("gpt-5-pro") ||
    normalized === "gpt-5"
  ) {
    return "5-0";
  }
  return null;
}

function inferKindFromText(value: string): ChatGptBrowserModelKind {
  if (value.includes("pro")) {
    return "pro";
  }
  if (value.includes("thinking")) {
    return "thinking";
  }
  if (value.includes("instant") || value.includes("fast")) {
    return "instant";
  }
  return null;
}

function visibleAliasesFor(
  version: ChatGptBrowserModelVersion | null,
  kind: ChatGptBrowserModelKind,
): ChatGptVisibleAlias[] {
  if (version === "5-5" && kind === "pro") {
    return [{ includes: ["pro", "extended"], excludes: ["thinking"] }];
  }
  if (version === "5-5" && kind === "thinking") {
    return [{ includes: ["thinking", "heavy"], excludes: ["pro"] }];
  }
  return [];
}

function addVersionMatcherTokens(
  version: ChatGptBrowserModelVersion,
  labelTokens: Set<string>,
  testIdTokens: Set<string>,
) {
  const dotted = version.replace("-", ".");
  const hyphenated = version;
  const compact = version.replace("-", "");
  labelTokens.add(dotted);
  labelTokens.add(`gpt-${dotted}`);
  labelTokens.add(`gpt${dotted}`);
  labelTokens.add(`gpt-${hyphenated}`);
  labelTokens.add(`gpt${hyphenated}`);
  labelTokens.add(`gpt${compact}`);
  labelTokens.add(`chatgpt ${dotted}`);
  testIdTokens.add(`gpt-${hyphenated}`);
  testIdTokens.add(`gpt${hyphenated}`);
  testIdTokens.add(`gpt${compact}`);
}

function addBaseModelTestIdToken(version: ChatGptBrowserModelVersion, testIdTokens: Set<string>) {
  testIdTokens.add(`model-switcher-gpt-${version}`);
}

function addKindTestIdTokens(
  version: ChatGptBrowserModelVersion | null,
  kind: Exclude<ChatGptBrowserModelKind, null>,
  testIdTokens: Set<string>,
) {
  if (!version) {
    return;
  }
  const dotted = version.replace("-", ".");
  testIdTokens.add(`gpt-${dotted}-${kind}`);
  testIdTokens.add(`gpt-${version}-${kind}`);
  testIdTokens.add(`gpt${version.replace("-", "")}${kind}`);
  testIdTokens.add(`model-switcher-gpt-${version}-${kind}`);
  testIdTokens.add(`model-switcher-gpt-${dotted}-${kind}`);
}
