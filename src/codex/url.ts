import { CODEX_FINDINGS_URL } from "../browser/constants.js";

const FINDING_ID_RE = /^[0-9a-f]{32}$/u;
const FINDINGS_PATH_PREFIX = "/codex/cloud/security/findings";

// RR v7 route-module ids for the security findings list. Only used as a fallback when the
// unscoped `.data` fetch fails; these are app-structure names, not a repo/account/id.
export const CODEX_LIST_ROUTES = "routes/codex.cloud.security,routes/codex.cloud.security.$tab";

function parseChatGptUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(
      `Invalid Codex findings URL: ${rawUrl} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "chatgpt.com" && hostname !== "chat.openai.com") {
    throw new Error(`Codex findings require a ChatGPT URL, received: ${rawUrl}`);
  }
  if (!url.pathname.startsWith(FINDINGS_PATH_PREFIX)) {
    throw new Error(`Codex findings require a ${FINDINGS_PATH_PREFIX} URL, received: ${rawUrl}`);
  }
  return url;
}

export function normalizeCodexFindingsUrl(rawUrl: string): string {
  if (!rawUrl.trim()) {
    return CODEX_FINDINGS_URL;
  }
  const url = parseChatGptUrl(rawUrl);
  // Preserve only a user-supplied `sev` filter; never inject a scanId/selectionId.
  const sev = url.searchParams.get("sev");
  url.search = "";
  if (sev !== null) {
    url.searchParams.set("sev", sev);
  }
  return url.toString();
}

export function buildFindingDetailUrl(baseUrl: string, id: string): string {
  const findingId = id.trim().toLowerCase();
  if (!FINDING_ID_RE.test(findingId)) {
    throw new Error(
      `--finding must be a 32-character hex finding id, received: ${JSON.stringify(id)}`,
    );
  }
  const url = new URL(normalizeCodexFindingsUrl(baseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${findingId}`;
  url.search = "";
  url.searchParams.set("sev", ""); // matches observed ?sev= ; no scanId/selectionId injected
  return url.toString();
}

export function buildFindingsDataUrl(baseUrl: string, opts?: { routes?: string }): string {
  const url = new URL(normalizeCodexFindingsUrl(baseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}.data`; // suffix-only; cannot smuggle host/scheme
  url.search = "";
  url.searchParams.set("sev", "");
  if (opts?.routes) {
    url.searchParams.set("_routes", opts.routes);
  }
  return url.toString();
}
