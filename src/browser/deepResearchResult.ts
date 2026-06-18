export function isDeepResearchIncompleteText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tailIsPlanningPanel =
    text.length <= 1_500 &&
    lines.length >= 4 &&
    lines.length <= 20 &&
    /^update$/i.test(lines[1] ?? "") &&
    /^stop research$/i.test(lines.at(-1) ?? "") &&
    /^determining steps for creating a report(?:\.\.\.)?$/i.test(lines.at(-2) ?? "");
  return (
    normalized === "called tool" ||
    normalized === "used tool" ||
    normalized === "użyto narzędzia" ||
    normalized === "narzędzie wywołane" ||
    normalized === "planning" ||
    normalized === "researching" ||
    normalized === "searching the web" ||
    (text.trimStart().startsWith("<system-reminder>") &&
      /<system-reminder>[\s\S]*#\s*plan mode\b/i.test(text)) ||
    tailIsPlanningPanel
  );
}
