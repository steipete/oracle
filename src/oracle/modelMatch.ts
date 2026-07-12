// Data-driven matcher: map a user's requested model string to the options that
// the ChatGPT picker actually offers (a ModelInventory). Pure and unit-tested.
//
// This replaces the hard-coded version ladder in modelSelection.ts. A request is
// parsed into an optional {version, effort}; each part is resolved against the
// live inventory. Because version parsing is generic (any number), a brand-new
// model (gpt-5.7, gpt-6, o4) resolves the moment ChatGPT lists it — no new code.

import type { InvOption, ModelInventory } from "./modelInventory.js";
import { normalizeText } from "./modelInventory.js";

/** Canonical effort levels, aligned with the live picker + thinkingTime aliases. */
export type EffortKey = "instant" | "medium" | "high" | "extra-high" | "pro";

export interface ParsedRequest {
  raw: string;
  /** Numeric version core, e.g. "5.6", "6", or "o3". Undefined = version-agnostic. */
  versionKey?: string;
  family?: "gpt" | "o" | "gemini" | "claude";
  effort?: EffortKey;
  /** Bare "thinking" with no explicit level — ambiguous effort intent. */
  bareThinking?: boolean;
}

export type MatchResult =
  | {
      status: "matched";
      version?: InvOption;
      effort?: InvOption;
      confidence: number;
      reason: string;
    }
  | {
      status: "not-found" | "ambiguous";
      reason: string;
      /** Human-readable list of what IS available, for a helpful error. */
      candidates: string[];
    };

/** Extract the comparable version core from any label or request fragment. */
export function versionKeyOf(text: string): string {
  const t = text.toLowerCase();
  const gpt = t.match(/gpt[-\s]?(\d+(?:\.\d+)?)/);
  if (gpt) return gpt[1];
  const o = t.match(/(?:^|[^a-z])(o\d+(?:-[a-z]+)?)/);
  if (o) return o[1];
  const bare = t.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
  if (bare) return bare[1];
  return normalizeText(text);
}

/** Canonicalize an effort label/word to an EffortKey, or undefined if not one. */
export function effortKeyOf(text: string): EffortKey | undefined {
  const t = normalizeText(text);
  if (/\bpro\b/.test(t)) return "pro";
  if (/\binstant\b|\blight\b|\blow\b|\bfast\b/.test(t)) return "instant";
  if (/\bextra high\b|\bxhigh\b|\bextrahigh\b|\bheavy\b/.test(t)) return "extra-high";
  if (/\bhigh\b|\bextended\b/.test(t)) return "high";
  if (/\bmedium\b|\bstandard\b/.test(t)) return "medium";
  return undefined;
}

/** Parse a raw `-m` value into version + effort intent. */
export function parseRequest(request: string): ParsedRequest {
  // Keep dots for version extraction ("5.6" must not collapse to "5 6").
  const r = request.toLowerCase().trim();
  const parsed: ParsedRequest = { raw: request };

  // Version core (dot-preserving)
  const gpt = r.match(/gpt[-\s]?(\d+(?:\.\d+)?)/);
  const o = r.match(/(?:^|[^a-z])(o\d+(?:[-\s][a-z]+)?)/);
  const bare = r.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
  if (gpt) parsed.versionKey = gpt[1];
  else if (o) {
    parsed.versionKey = o[1].replace(/\s+/g, "-");
    parsed.family = "o";
  } else if (bare) parsed.versionKey = bare[1];

  // Family
  if (/\bgemini\b/.test(r)) parsed.family = "gemini";
  else if (/\bclaude\b/.test(r)) parsed.family = "claude";
  else if (!parsed.family && (/\bgpt\b/.test(r) || parsed.versionKey)) parsed.family = "gpt";

  // Effort (effortKeyOf normalizes internally, dots don't matter here)
  const effort = effortKeyOf(request);
  if (effort) parsed.effort = effort;
  else if (/\bthinking\b/.test(r)) parsed.bareThinking = true;

  return parsed;
}

function listVersions(inv: ModelInventory): string[] {
  return inv.versions.map((v) => v.text);
}
function listEfforts(inv: ModelInventory): string[] {
  return inv.efforts.map((e) => e.text);
}

/**
 * Resolve a requested model against the live inventory.
 *
 * - Missing version → keep current version (version-agnostic, e.g. "-m Pro").
 * - Missing effort → keep current effort.
 * - Requested part not offered → `not-found` with the real candidate list
 *   (so the caller can print a useful error instead of clicking a phantom).
 */
export function matchModelToInventory(
  request: string,
  inv: ModelInventory,
): MatchResult {
  const parsed = parseRequest(request);

  let version: InvOption | undefined;
  if (parsed.versionKey) {
    version = inv.versions.find((v) => versionKeyOf(v.text) === parsed.versionKey);
    if (!version) {
      return {
        status: "not-found",
        reason: `Requested version "${parsed.versionKey}" is not offered by ChatGPT right now.`,
        candidates: listVersions(inv),
      };
    }
  }

  let effort: InvOption | undefined;
  if (parsed.effort) {
    effort = inv.efforts.find((e) => effortKeyOf(e.text) === parsed.effort);
    if (!effort) {
      return {
        status: "not-found",
        reason: `Requested effort "${parsed.effort}" is not offered for the selected model.`,
        candidates: listEfforts(inv),
      };
    }
  }

  if (!version && !effort) {
    // Nothing actionable parsed out of the request.
    if (parsed.bareThinking) {
      return {
        status: "ambiguous",
        reason: `"thinking" has no explicit level; choose one of the effort options.`,
        candidates: listEfforts(inv),
      };
    }
    return {
      status: "ambiguous",
      reason: `Could not map "${request}" to a version or effort.`,
      candidates: [...listVersions(inv), ...listEfforts(inv)],
    };
  }

  // Confidence: full when every requested part resolved exactly; version-only or
  // effort-only requests are still high-confidence (the other axis stays current).
  const confidence = version && effort ? 1 : 0.9;
  const parts = [
    version ? `version=${version.text}` : "version=(keep current)",
    effort ? `effort=${effort.text}` : "effort=(keep current)",
  ];
  return {
    status: "matched",
    version,
    effort,
    confidence,
    reason: `Matched ${request} → ${parts.join(", ")}.`,
  };
}
