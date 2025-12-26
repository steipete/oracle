import type { ChromeClient, BrowserLogger } from '../types.js';

/**
 * Robustly captures a shareable link from the ChatGPT or Gemini interface.
 * Uses a multi-strategy approach:
 * 1. API Interception: Hooks window.fetch to catch the share_url from the backend response.
 * 2. Clipboard Interception: Hooks navigator.clipboard to catch the URL when the user/UI clicks "Copy".
 * 3. UI Automation: Triggers the share flow by clicking buttons (Header or History menu).
 * 4. DOM Polling: Scans inputs and text for the public /share/ URL as a fallback.
 */
export async function shareConversation(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
): Promise<string | null> {
  logger('Initiating share link capture flow...');

  // 1. Inject Interceptors into the browser context
  await Runtime.evaluate({
    expression: `
      window._capturedShareLink = null;
      
      // Clipboard Hook: Catch the link when ChatGPT tries to copy it to clipboard
      if (navigator.clipboard) {
        try {
          const originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
          navigator.clipboard.writeText = async (text) => {
            if (text && (text.includes('/share/') || text.includes('chatgpt.com'))) {
              window._capturedShareLink = text;
            }
            return originalWrite(text).catch(() => {});
          };
        } catch (e) {}
      }

      // API Hook: Catch the share URL directly from the backend API response
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const res = await originalFetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0].url;
        if (url.includes('/backend-api/share')) {
          const clone = res.clone();
          clone.json().then(data => {
            if (data.share_url) window._capturedShareLink = data.share_url;
          }).catch(() => {});
        }
        return res;
      };
    `,
  });

  const expression = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const findButton = (query) => {
      const q = query.toLowerCase();
      return Array.from(document.querySelectorAll('button')).find(b => {
        const text = (b.textContent || b.getAttribute('aria-label') || '').toLowerCase();
        return text.includes(q);
      });
    };

    try {
      // Step 1: Open Share Modal
      // Strategy A: Header button (Primary)
      let shareBtn = document.querySelector('button[aria-label="Share Chat"], button[aria-label="Share"], button[data-testid="share-button"]');
      if (!shareBtn) shareBtn = findButton('share');
      
      if (shareBtn) {
        shareBtn.click();
      } else {
        // Strategy B: Sidebar History options (Fallback)
        const historyBtn = document.querySelector('[data-testid="history-item-0-options"]');
        if (historyBtn) {
          historyBtn.click();
          await sleep(500);
          const menuShare = findButton('share');
          if (menuShare) menuShare.click();
        }
      }

      // Step 2: Extract Link (Polling cycle)
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        // If link is captured by hooks (Clipboard/API)
        if (window._capturedShareLink) return { success: true, url: window._capturedShareLink };

        // Attempt to trigger the generation/copy in UI
        const createBtn = findButton('create link') || findButton('get link') || findButton('shared link');
        if (createBtn) {
          createBtn.click();
          await sleep(1000);
        }

        const copyBtn = findButton('copy link');
        if (copyBtn) {
          copyBtn.click();
          await sleep(500);
        }

        // Search DOM for the link
        const input = document.querySelector('input[readonly][value*="/share/"]');
        if (input) return { success: true, url: input.value };
        
        const match = document.body.innerText.match(/https:\\/\\/(chatgpt\\.com|gemini\\.google\\.com)\\/share\\/[a-z0-9-]+/i);
        if (match) return { success: true, url: match[0] };

        await sleep(400);
      }

      return { success: false, error: 'link-not-found' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  })()`;

  try {
    const { result } = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
    
    if (result?.value?.success) {
      logger(`Captured share link: ${result.value.url}`);
      return result.value.url;
    }
    
    // Final check on the intercepted variable
    const finalCheck = await Runtime.evaluate({ expression: 'window._capturedShareLink', returnByValue: true });
    if (finalCheck.result?.value && finalCheck.result.value.includes('/share/')) {
      logger(`Captured share link via intercept fallback: ${finalCheck.result.value}`);
      return finalCheck.result.value;
    }

    logger(`Share link flow ended without capture: ${result?.value?.error || 'unknown'}`);
  } catch (err) {
    logger(`Error in share link capture: ${err}`);
  }
  return null;
}
