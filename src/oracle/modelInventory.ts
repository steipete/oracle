// Model inventory: a data-driven snapshot of what the ChatGPT model picker
// *actually* offers right now, plus pure helpers to build it from scraped DOM.
//
// Why this exists: the picker UI changes shape whenever OpenAI ships a model
// (GPT-5.6 "Sol" dropped every `data-testid` and moved to a version×effort
// matrix). Hard-coding a version ladder (5-0…5-6) means editing ~10 call sites
// per launch. Instead we read the live options and match against them, so a new
// version works with zero code changes.
//
// The DOM scraping lives in ../browser/actions/modelInventoryScrape.ts and only
// produces RawMenuItem[]. Everything here is pure and unit-tested.

/** One raw item as scraped from a picker menu, before classification. */
export interface RawMenuItem {
  /** Visible text, possibly noisy (e.g. "Instant5.5", "GPT-5.4Leaving on July 23"). */
  text: string;
  role?: string | null;
  /** "true" when this option is the current selection. */
  ariaChecked?: string | null;
  /** "menu" when the item opens a submenu (the version trigger). */
  ariaHaspopup?: string | null;
  /** "checked" | "unchecked" | "open" | "closed" | null. */
  dataState?: string | null;
  /** Which menu this came from: the top intelligence menu or the version submenu. */
  scope?: "top" | "submenu";
}

/** A normalized, selectable option in the picker. */
export interface InvOption {
  /** Cleaned display label, e.g. "GPT-5.6 Sol", "Pro". Used for clicking + matching. */
  text: string;
  /** Original noisy DOM text, retained so the click layer can find the exact node. */
  raw: string;
  /** True if this option is currently selected. */
  current: boolean;
}

/** The live picker state: which versions and efforts exist, and what's active. */
export interface ModelInventory {
  versions: InvOption[];
  efforts: InvOption[];
  currentVersion?: InvOption;
  currentEffort?: InvOption;
}

/** Lowercase alnum-collapsed form used for stable comparisons. */
export function normalizeText(value: string): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A menu item names a model *version* (as opposed to an effort/intelligence
 * level) when its text looks like a version id, or when it opens a submenu.
 * Deliberately generic: matches gpt-5.6, gpt 6, o3, o4-mini, etc. — no fixed list.
 */
export function looksLikeVersion(text: string, ariaHaspopup?: string | null): boolean {
  if (ariaHaspopup === "menu") return true;
  const t = text.toLowerCase();
  return (
    /\bgpt[-\s]?\d/.test(t) || // gpt-5.6, gpt 6
    /(^|[^a-z])o\d/.test(t) || // o3, o4-mini
    /\bsol\b/.test(t) // codename that trails a version (GPT-5.6 Sol)
  );
}

/** Strip a trailing deprecation note like "Leaving on July 23". */
function stripDeprecationNote(text: string): string {
  return text.replace(/\s*leaving on .*$/i, "").trim();
}

/** Clean a version label: collapse whitespace, drop deprecation notes. Keep numbers. */
export function cleanVersionLabel(text: string): string {
  return stripDeprecationNote(text.replace(/\s+/g, " ").trim());
}

/**
 * Clean an effort label: drop a trailing version subscript that the UI glues on,
 * e.g. "Instant5.5" -> "Instant". Never applied to version labels (would eat "o3").
 */
export function cleanEffortLabel(text: string): string {
  const collapsed = stripDeprecationNote(text.replace(/\s+/g, " ").trim());
  // A letter (optionally spaced) immediately followed by a trailing version number.
  return collapsed.replace(/([A-Za-z])\s*\d+(?:\.\d+)?$/, "$1").trim();
}

function isChecked(item: RawMenuItem): boolean {
  return item.ariaChecked === "true" || item.dataState === "checked";
}

/**
 * Build a ModelInventory from scraped raw items. Pure and deterministic.
 * De-dupes versions/efforts by normalized label (the current version appears
 * both as the top-menu trigger and as a checked radio in the submenu).
 */
export function buildInventoryFromRawItems(raw: RawMenuItem[]): ModelInventory {
  const versions: InvOption[] = [];
  const efforts: InvOption[] = [];
  const versionByKey = new Map<string, InvOption>();
  const effortByKey = new Map<string, InvOption>();

  for (const item of raw) {
    const rawText = (item.text ?? "").trim();
    if (!rawText) continue;

    const version = looksLikeVersion(rawText, item.ariaHaspopup);
    const label = version ? cleanVersionLabel(rawText) : cleanEffortLabel(rawText);
    const key = normalizeText(label);
    if (!key) continue;

    const target = version ? versionByKey : effortByKey;
    const list = version ? versions : efforts;
    const existing = target.get(key);
    if (existing) {
      // Same option seen twice (trigger + submenu radio): keep current=true if either was.
      if (isChecked(item)) existing.current = true;
      continue;
    }
    const opt: InvOption = { text: label, raw: rawText, current: isChecked(item) };
    target.set(key, opt);
    list.push(opt);
  }

  return {
    versions,
    efforts,
    currentVersion: versions.find((v) => v.current),
    currentEffort: efforts.find((e) => e.current),
  };
}
