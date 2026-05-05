import type { RunOracleOptions } from "../oracle.js";
import type { BrowserSessionConfig } from "../sessionStore.js";

export type RecommendedConversationMode = "one-shot" | "multi-turn" | "deep-research" | "project";

export interface ConversationModeRecommendation {
  mode: RecommendedConversationMode;
  reason: string;
}

export function isChatGptProjectUrl(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.hostname === "chatgpt.com" && /\/g\/[^/]+\/project(?:\/|$)/.test(url.pathname);
  } catch {
    return /chatgpt\.com\/g\/[^/\s]+\/project(?:[/?#\s]|$)/i.test(trimmed);
  }
}

export function recommendConversationMode({
  runOptions,
  browserConfig,
}: {
  runOptions: RunOracleOptions;
  browserConfig?: BrowserSessionConfig;
}): ConversationModeRecommendation {
  const followUpCount =
    runOptions.browserFollowUps?.filter((entry) => entry.trim().length > 0).length ?? 0;
  if (browserConfig?.researchMode === "deep") {
    return {
      mode: "deep-research",
      reason: "Deep Research is active, so Oracle should use ChatGPT's research lifecycle.",
    };
  }
  if (followUpCount > 0) {
    return {
      mode: "multi-turn",
      reason: `${followUpCount} explicit browser follow-up prompt${followUpCount === 1 ? "" : "s"} requested.`,
    };
  }
  const url = browserConfig?.chatgptUrl ?? browserConfig?.url;
  if (isChatGptProjectUrl(url)) {
    return {
      mode: "project",
      reason: "The ChatGPT URL points at a Project, so context may be persistent there.",
    };
  }
  if (looksLikeOngoingProjectPrompt(runOptions.prompt)) {
    return {
      mode: "project",
      reason: "The prompt describes an ongoing architecture/product stream.",
    };
  }
  return {
    mode: "one-shot",
    reason: "No research mode, follow-ups, or Project context was requested.",
  };
}

function looksLikeOngoingProjectPrompt(prompt: string | undefined): boolean {
  const text = prompt?.toLowerCase() ?? "";
  if (!text.trim()) return false;
  const durableContext =
    /\b(ongoing|long-running|persistent|project context|shared context|architecture stream|product stream)\b/.test(
      text,
    );
  const projectDomain = /\b(architecture|product|roadmap|migration|platform|project)\b/.test(text);
  return durableContext && projectDomain;
}
