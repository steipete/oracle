import { isIP } from "node:net";
import type { ChromeClient } from "./types.js";
import { STOP_BUTTON_SELECTORS } from "./constants.js";

export function normalizeChromeHost(host: string): string {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || (isIP(value) === 4 && value.startsWith("127."))
    ? "loopback"
    : value;
}

export function buildTargetClaimExpression(claimId: string): string {
  return `(() => {
    if (window !== window.top) return true;
    try {
      const claim = JSON.parse(sessionStorage.getItem('oracle:target-claim') || 'null');
      if (claim?.retiring) return false;
      sessionStorage.setItem('oracle:target-claim', JSON.stringify({ id: ${JSON.stringify(claimId)}, retiring: false }));
      return true;
    } catch { return false; }
  })()`;
}

export function buildTargetRetirementExpression(
  claimId: string,
  conversationId: string,
  reservationId: string,
  options: { allowGenerating?: boolean } = {},
): string {
  return `(() => {
    let claim;
    try { claim = JSON.parse(sessionStorage.getItem('oracle:target-claim') || 'null'); } catch { return false; }
    if (!claim || claim.id !== ${JSON.stringify(claimId)} || claim.retiring) return false;
    const id = location.pathname.match(/\\/c\\/([^/]+)/)?.[1];
    if (id !== ${JSON.stringify(conversationId)}) return false;
    const generating = Array.from(document.querySelectorAll(${JSON.stringify(STOP_BUTTON_SELECTORS.join(","))})).some(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
    if (generating && !${JSON.stringify(options.allowGenerating === true)}) return false;
    claim.retiring = true;
    claim.retirementId = ${JSON.stringify(reservationId)};
    try { sessionStorage.setItem('oracle:target-claim', JSON.stringify(claim)); } catch { return false; }
    return true;
  })()`;
}

export function buildTargetRetirementRollbackExpression(
  claimId: string,
  reservationId: string,
): string {
  return `(() => { try {
    const claim = JSON.parse(sessionStorage.getItem('oracle:target-claim') || 'null');
    if (claim?.id === ${JSON.stringify(claimId)} && claim.retirementId === ${JSON.stringify(reservationId)}) {
      claim.retiring = false;
      delete claim.retirementId;
      sessionStorage.setItem('oracle:target-claim', JSON.stringify(claim));
    }
  } catch {} })()`;
}

/** Per-tab storage survives document replacement and serializes acquisition with retirement. */
export async function claimBrowserTarget(
  runtime: ChromeClient["Runtime"],
  claimId: string,
): Promise<void> {
  const source = buildTargetClaimExpression(claimId);
  const claim = await runtime.evaluate({ expression: source, returnByValue: true });
  if (claim.exceptionDetails || claim.result?.value !== true)
    throw new Error("This Oracle tab is being retired after recovery; choose another browser tab.");
}
