import type {
  BrowserArchiveMode,
  BrowserArchiveResult,
  BrowserLogger,
  BrowserResearchMode,
  ChromeClient,
} from "../types.js";

export interface BrowserArchiveDecision {
  mode: BrowserArchiveMode;
  shouldArchive: boolean;
  reason: string;
}

export function isProjectChatgptUrl(url?: string | null): boolean {
  return /\/project(?:[/?#]|$)/i.test(url ?? "");
}

export function resolveBrowserArchiveDecision({
  mode = "auto",
  chatgptUrl,
  conversationUrl,
  researchMode,
  followUpCount,
}: {
  mode?: BrowserArchiveMode;
  chatgptUrl?: string | null;
  conversationUrl?: string | null;
  researchMode?: BrowserResearchMode;
  followUpCount?: number;
}): BrowserArchiveDecision {
  if (mode === "never") {
    return { mode, shouldArchive: false, reason: "disabled" };
  }
  if (!conversationUrl) {
    return { mode, shouldArchive: false, reason: "missing-conversation-url" };
  }
  if (mode === "always") {
    return { mode, shouldArchive: true, reason: "forced" };
  }
  if (isProjectChatgptUrl(chatgptUrl) || isProjectChatgptUrl(conversationUrl)) {
    return { mode, shouldArchive: false, reason: "project-conversation" };
  }
  if (researchMode === "deep") {
    return { mode, shouldArchive: false, reason: "deep-research" };
  }
  if ((followUpCount ?? 0) > 0) {
    return { mode, shouldArchive: false, reason: "multi-turn" };
  }
  return { mode, shouldArchive: true, reason: "successful-one-shot" };
}

export async function archiveChatGptConversation(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  {
    mode,
    conversationUrl,
  }: {
    mode: BrowserArchiveMode;
    conversationUrl?: string | null;
  },
): Promise<BrowserArchiveResult> {
  const evaluated = await Runtime.evaluate({
    expression: buildArchiveConversationExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = evaluated.result?.value as
    | { status: "archived"; conversationUrl?: string | null }
    | { status: "skipped"; reason: string; conversationUrl?: string | null }
    | { status: "failed"; error: string; conversationUrl?: string | null }
    | undefined;
  const resolvedUrl = value?.conversationUrl ?? conversationUrl ?? undefined;
  if (value?.status === "archived") {
    logger("[browser] Archived ChatGPT conversation after saving local artifacts.");
    return { mode, attempted: true, archived: true, conversationUrl: resolvedUrl };
  }
  const reason = value?.status === "skipped" ? value.reason : "archive-failed";
  const error = value?.status === "failed" ? value.error : undefined;
  logger(`[browser] ChatGPT archive skipped (${error ?? reason}).`);
  return {
    mode,
    attempted: true,
    archived: false,
    reason,
    conversationUrl: resolvedUrl,
    error,
  };
}

export function buildArchiveConversationExpressionForTest(): string {
  return buildArchiveConversationExpression();
}

function buildArchiveConversationExpression(): string {
  return `(() => {
    const conversationUrl = typeof location === 'object' ? location.href : null;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) =>
      String(value ?? '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();
    const isVisible = (element) => {
      if (!element || !(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelFor = (element) =>
      normalize([
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.textContent,
      ].filter(Boolean).join(' '));
	    const click = (element) => {
	      const rect = element.getBoundingClientRect();
	      const eventInit = {
	        bubbles: true,
	        cancelable: true,
	        view: window,
	        clientX: rect.left + rect.width / 2,
	        clientY: rect.top + rect.height / 2,
	        button: 0,
	      };
	      if (typeof PointerEvent === 'function') {
	        element.dispatchEvent(new PointerEvent('pointerdown', {
	          ...eventInit,
	          buttons: 1,
	          pointerId: 1,
	          pointerType: 'mouse',
	          isPrimary: true,
	        }));
	      }
	      element.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, buttons: 1 }));
	      if (typeof PointerEvent === 'function') {
	        element.dispatchEvent(new PointerEvent('pointerup', {
	          ...eventInit,
	          buttons: 0,
	          pointerId: 1,
	          pointerType: 'mouse',
	          isPrimary: true,
	        }));
	      }
	      element.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
	      element.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
	    };
    const findConversationMenuButton = () => {
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element));
      const labelled = buttons
        .map((element) => ({ element, label: labelFor(element), rect: element.getBoundingClientRect() }))
        .filter(({ label }) =>
          label.includes('more') ||
          label.includes('conversation options') ||
          label.includes('open menu') ||
          label.includes('więcej') ||
          label.includes('opcje')
        );
      const headerCandidates = labelled
        .filter(({ rect }) => rect.top < 180 && rect.right > window.innerWidth - 420)
        .sort((a, b) => b.rect.right - a.rect.right);
      return (headerCandidates[0] ?? labelled[0])?.element ?? null;
    };
	    const visibleMenuCandidates = () => {
	      const menuRoots = Array.from(document.querySelectorAll('[role="menu"]'))
	        .filter((element) => element instanceof HTMLElement && isVisible(element));
	      const roots = menuRoots.length > 0 ? menuRoots : [document];
	      return roots.flatMap((root) =>
	        Array.from(root.querySelectorAll('[role="menuitem"],[role="option"],button,div[tabindex],a')),
	      ).filter((element) => element instanceof HTMLElement && isVisible(element));
	    };
	    const findArchiveMenuItem = () => {
	      const candidates = visibleMenuCandidates();
	      return candidates.find((element) => {
	        const label = labelFor(element);
	        if (!label) return false;
	        if (label.includes('unarchive') || label.includes('restore')) return false;
	        return label.includes('archive') || label.includes('archiwizuj');
	      }) ?? null;
	    };
	    const findArchiveConfirmationButton = () => {
	      const candidates = Array.from(document.querySelectorAll('[role="dialog"] button,[role="dialog"] [role="button"]'))
	        .filter((element) => element instanceof HTMLElement && isVisible(element));
	      return candidates.find((element) => {
	        const label = labelFor(element);
	        if (!label) return false;
	        if (label.includes('unarchive') || label.includes('restore')) return false;
	        return label === 'archive' || label === 'archiwizuj' || label.includes('archive conversation');
	      }) ?? null;
	    };
	    const hasUnarchiveMenuItem = () => {
	      const candidates = visibleMenuCandidates();
	      return candidates.some((element) => {
	        const label = labelFor(element);
	        return (
	          label.includes('unarchive') ||
	          label.includes('restore') ||
	          label.includes('przywróć') ||
	          label.includes('przywroc')
	        );
	      });
	    };
	    const hasArchiveConfirmation = () => {
	      const visibleText = Array.from(document.querySelectorAll('[role="status"],[role="alert"],[data-testid*="toast"],[class*="toast"],[class*="snackbar"]'))
	        .filter((element) => element instanceof HTMLElement && isVisible(element))
	        .map((element) => labelFor(element))
	        .join(' ');
	      return (
	        visibleText.includes('archived') ||
	        visibleText.includes('conversation archived') ||
	        visibleText.includes('chat archived') ||
	        visibleText.includes('zarchiwizowano') ||
	        visibleText.includes('archiwum')
	      );
	    };
	    const waitForArchiveConfirmation = async () => {
	      const deadline = Date.now() + 3000;
	      while (Date.now() < deadline) {
	        if (conversationUrl && location.href !== conversationUrl) return true;
	        if (hasArchiveConfirmation()) return true;
	        await sleep(150);
	      }
	      return false;
	    };
	    const verifyArchivedStateFromMenu = async () => {
	      const menuButton = findConversationMenuButton();
	      if (!menuButton) return false;
	      click(menuButton);
	      await sleep(300);
	      const archived = hasUnarchiveMenuItem();
	      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	      return archived;
	    };
	    return (async () => {
	      const menuButton = findConversationMenuButton();
      if (!menuButton) {
        return { status: 'skipped', reason: 'conversation-menu-not-found', conversationUrl };
      }
      click(menuButton);
      await sleep(350);
      const archiveItem = findArchiveMenuItem();
      if (!archiveItem) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { status: 'skipped', reason: 'archive-menu-item-not-found', conversationUrl };
	      }
	      click(archiveItem);
	      await sleep(350);
	      const confirmButton = findArchiveConfirmationButton();
	      if (confirmButton) {
	        click(confirmButton);
	        await sleep(500);
	      }
	      if (await waitForArchiveConfirmation()) {
	        return { status: 'archived', conversationUrl };
	      }
	      if (await verifyArchivedStateFromMenu()) {
	        return { status: 'archived', conversationUrl };
	      }
	      return { status: 'skipped', reason: 'archive-not-confirmed', conversationUrl };
	    })().catch((error) => ({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      conversationUrl,
    }));
  })()`;
}
