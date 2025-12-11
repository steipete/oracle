import type { ChromeClient, BrowserLogger } from '../types.js';
import { buildClickDispatcher } from './domEvents.js';

/**
 * Enables ChatGPT Agent mode by clicking the "+" button and selecting "Agent" from the menu.
 */
export async function enableAgentMode(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
): Promise<{ status: 'enabled' | 'already-enabled' | 'not-found' | 'button-missing' }> {
  const { result } = await Runtime.evaluate({
    expression: buildAgentModeExpression(),
    awaitPromise: true,
    returnByValue: true,
  });

  const value = result?.value as { status: string; debug?: string } | undefined;

  switch (value?.status) {
    case 'enabled':
      logger('Agent mode: enabled');
      return { status: 'enabled' };
    case 'already-enabled':
      logger('Agent mode: already active');
      return { status: 'already-enabled' };
    case 'not-found':
      logger(`Agent mode: option not found in menu${value.debug ? ` - ${value.debug}` : ''}`);
      return { status: 'not-found' };
    case 'button-missing':
      logger('Agent mode: plus button not found');
      return { status: 'button-missing' };
    default:
      logger('Agent mode: unexpected result');
      return { status: 'button-missing' };
  }
}

function buildAgentModeExpression(): string {
  return `(async () => {
    ${buildClickDispatcher()}

    const PLUS_BUTTON_SELECTOR = 'button[data-testid="composer-plus-btn"]';
    const MENU_WAIT_MS = 500;
    const MAX_ATTEMPTS = 10;
    const ATTEMPT_INTERVAL_MS = 300;

    // Find the plus button
    const plusButton = document.querySelector(PLUS_BUTTON_SELECTOR);
    if (!plusButton) {
      return { status: 'button-missing' };
    }

    // Click to open menu
    dispatchClickSequence(plusButton);
    await new Promise(r => setTimeout(r, MENU_WAIT_MS));

    // Search for Agent option in opened menus/popups
    const findAgentOption = () => {
      // Look in any menu or popup that appeared
      const menuContainers = document.querySelectorAll(
        '[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-state="open"]'
      );

      for (const container of menuContainers) {
        // Look for items containing "agent"
        const items = container.querySelectorAll('button, [role="menuitem"], [role="option"], div[tabindex]');
        for (const item of items) {
          const text = (item.textContent || '').toLowerCase().trim();
          const testId = (item.getAttribute('data-testid') || '').toLowerCase();
          if (text.includes('agent') || testId.includes('agent')) {
            return item;
          }
        }
      }

      // Also check body-level floating elements
      const floatingDivs = document.querySelectorAll('body > div[data-radix-popper-content-wrapper]');
      for (const div of floatingDivs) {
        const items = div.querySelectorAll('button, [role="menuitem"], div[tabindex]');
        for (const item of items) {
          const text = (item.textContent || '').toLowerCase().trim();
          if (text.includes('agent')) {
            return item;
          }
        }
      }

      return null;
    };

    // Try to find and click the agent option
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const agentOption = findAgentOption();
      if (agentOption) {
        dispatchClickSequence(agentOption);
        await new Promise(r => setTimeout(r, 200));
        return { status: 'enabled' };
      }

      // Menu might not be open yet, try clicking again
      if (attempt > 0 && attempt % 3 === 0) {
        dispatchClickSequence(plusButton);
      }
      await new Promise(r => setTimeout(r, ATTEMPT_INTERVAL_MS));
    }

    // Collect debug info about what we found
    const menuContainers = document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content]');
    const menuTexts = Array.from(menuContainers).map(m => (m.textContent || '').slice(0, 100)).join(' | ');

    return {
      status: 'not-found',
      debug: menuTexts ? \`Found menus: \${menuTexts}\` : 'No menus found'
    };
  })()`;
}
