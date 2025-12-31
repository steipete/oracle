/**
 * Gemini Deep Research Actions
 *
 * Handles the Deep Research workflow:
 * 1. Wait for research plan to appear
 * 2. Click "Start research" button
 * 3. Wait for research completion (10-20 minutes)
 * 4. Extract results from immersive panel
 * 5. Copy content via clipboard or export fallback
 */

import type { ChromeClient } from '../../browser/types.js';
import type { BrowserLogger, GeminiResponseSnapshot } from '../types.js';
import {
  GEMINI_DEEP_RESEARCH_SELECTORS,
  GEMINI_TIMEOUTS,
} from '../constants.js';
import { delay } from '../../browser/utils.js';

type CDPRuntime = ChromeClient['Runtime'];

export interface DeepResearchStatus {
  /** Whether research is in progress */
  inProgress: boolean;
  /** Whether research is complete */
  isComplete: boolean;
  /** Current phase (planning, researching, analyzing, complete) */
  phase: 'waiting' | 'planning' | 'researching' | 'analyzing' | 'complete' | 'error';
  /** Progress message if available */
  message?: string;
  /** Research plan title */
  title?: string;
  /** Number of research steps */
  stepCount?: number;
  /** Current step being executed */
  currentStep?: number;
}

export interface DeepResearchResult {
  /** Research report text */
  text: string;
  /** HTML content */
  html?: string;
  /** Markdown content (from copy or conversion) */
  markdown?: string;
  /** Research title */
  title?: string;
  /** Whether copy was successful */
  copySucceeded: boolean;
  /** Whether export to docs was triggered as fallback */
  exportTriggered: boolean;
}

/**
 * Wait for the Deep Research confirmation widget to appear
 * This shows the research plan with "Start research" button
 */
export async function waitForResearchPlan(
  runtime: CDPRuntime,
  timeoutMs: number = 30_000,
  logger: BrowserLogger,
): Promise<{ found: boolean; title?: string }> {
  const deadline = Date.now() + timeoutMs;
  const selectors = GEMINI_DEEP_RESEARCH_SELECTORS;

  while (Date.now() < deadline) {
    const { result } = await runtime.evaluate({
      expression: `(() => {
        const widget = document.querySelector('${selectors.confirmationWidget}');
        if (!widget) return { found: false };

        const title = widget.querySelector('${selectors.researchTitle}');
        const startBtn = widget.querySelector('${selectors.startResearchButton}');

        if (startBtn) {
          return {
            found: true,
            title: title?.textContent?.trim() || '',
            hasStartButton: true,
          };
        }

        return { found: false };
      })()`,
      returnByValue: true,
    });

    const outcome = result?.value as { found: boolean; title?: string; hasStartButton?: boolean } | undefined;
    if (outcome?.found && outcome?.hasStartButton) {
      logger(`[deep-research] Research plan ready: "${outcome.title || 'Untitled'}"`);
      return { found: true, title: outcome.title };
    }

    await delay(500);
  }

  logger('[deep-research] Research plan not found within timeout');
  return { found: false };
}

/**
 * Click the "Start research" button to begin Deep Research
 */
export async function startResearch(
  runtime: CDPRuntime,
  logger: BrowserLogger,
): Promise<boolean> {
  const selectors = GEMINI_DEEP_RESEARCH_SELECTORS;

  const { result } = await runtime.evaluate({
    expression: `(() => {
      // Method 1: Find by data-test-id
      const startBtn = document.querySelector('${selectors.startResearchButton}');
      if (startBtn && startBtn instanceof HTMLElement) {
        startBtn.click();
        return { clicked: true, method: 'data-test-id' };
      }

      // Method 2: Find by button text in confirmation widget
      const widget = document.querySelector('${selectors.confirmationWidget}');
      if (widget) {
        const buttons = widget.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() || '';
          if (text.includes('start research')) {
            btn.click();
            return { clicked: true, method: 'text-match' };
          }
        }
      }

      // Method 3: Find any button with "Start research" text
      const allButtons = document.querySelectorAll('button');
      for (const btn of allButtons) {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('start research')) {
          btn.click();
          return { clicked: true, method: 'global-text-match' };
        }
      }

      return { clicked: false };
    })()`,
    returnByValue: true,
  });

  const outcome = result?.value as { clicked: boolean; method?: string } | undefined;
  if (outcome?.clicked) {
    logger(`[deep-research] Started research via ${outcome.method}`);
    return true;
  }

  logger('[deep-research] Failed to find Start research button');
  return false;
}

/**
 * Check the current status of Deep Research
 * Uses multiple signals to determine completion:
 * 1. aria-busy="false" on response container
 * 2. Presence of action buttons (Share, Export, Copy)
 * 3. Substantial content length (>500 chars for a real report)
 * 4. No loading indicators visible
 */
export async function checkResearchStatus(
  runtime: CDPRuntime,
): Promise<DeepResearchStatus> {
  const { result } = await runtime.evaluate({
    expression: `(() => {
      // Check for confirmation widget (pre-start state)
      const widget = document.querySelector('deep-research-confirmation-widget');
      if (widget) {
        const startBtn = widget.querySelector('[data-test-id="confirm-button"]');
        if (startBtn && startBtn.offsetParent !== null) {
          return {
            inProgress: false,
            isComplete: false,
            phase: 'planning',
            title: widget.querySelector('[data-test-id="title"]')?.textContent?.trim(),
          };
        }
      }

      // Check for immersive panel (research in progress or complete)
      const panel = document.querySelector('deep-research-immersive-panel');
      if (!panel) {
        return { inProgress: false, isComplete: false, phase: 'waiting' };
      }

      // Check loading indicators - multiple types
      const loadingIndicators = [
        document.querySelector('[aria-busy="true"]'),
        document.querySelector('.loading-shimmer'),
        document.querySelector('mat-spinner'),
        document.querySelector('.mat-progress-spinner'),
        document.querySelector('[role="progressbar"]:not([aria-valuenow="100"])'),
      ].filter(Boolean);

      // Check for streaming/generating indicators
      const streamingEl = document.querySelector('[data-streaming="true"]');
      const generatingEl = document.querySelector('[data-generating="true"]');

      const isStillLoading = loadingIndicators.length > 0 || streamingEl || generatingEl;

      // Get content from the panel
      const markdownEl = panel.querySelector('.markdown-main-panel, .markdown, [class*="markdown"]');
      const contentText = markdownEl?.textContent?.trim() || '';
      const contentLength = contentText.length;

      // Check for "Share and export" button - THE primary completion signal
      // This button only appears after Deep Research finishes
      const exportMenuBtn = document.querySelector('[data-test-id="export-menu-button"]');
      const hasExportMenuButton = exportMenuBtn && exportMenuBtn.offsetParent !== null;

      // Also check for action buttons that may be visible
      const hasShareBtn = !!document.querySelector('[data-test-id="share-button"]');
      const hasExportBtn = !!document.querySelector('[data-test-id="export-to-docs-button"]');
      const hasCopyBtn = !!document.querySelector('[data-test-id="copy-button"]');
      const hasActionButtons = hasShareBtn || hasExportBtn || hasCopyBtn || hasExportMenuButton;

      // Research is complete if:
      // 1. Has export menu button (strongest signal) OR
      // 2. No loading indicators AND has action buttons AND substantial content
      const isComplete = hasExportMenuButton ||
                        (!isStillLoading && hasActionButtons && contentLength > 500);

      if (isComplete) {
        return {
          inProgress: false,
          isComplete: true,
          phase: 'complete',
          message: 'Research complete (' + contentLength + ' chars, export=' + hasExportMenuButton + ')',
        };
      }

      // Still in progress
      if (isStillLoading || contentLength < 100) {
        return {
          inProgress: true,
          isComplete: false,
          phase: 'researching',
          message: 'Research in progress... (' + contentLength + ' chars so far)',
        };
      }

      // Content exists but waiting for more
      return {
        inProgress: true,
        isComplete: false,
        phase: 'analyzing',
        message: 'Analyzing results... (' + contentLength + ' chars)',
      };
    })()`,
    returnByValue: true,
  });

  return (result?.value as DeepResearchStatus) ?? {
    inProgress: false,
    isComplete: false,
    phase: 'waiting',
  };
}

// Minimum wait time for Deep Research (10 minutes) - research typically takes at least this long
const MIN_RESEARCH_WAIT_MS = 10 * 60 * 1000;

/**
 * Wait for Deep Research to complete
 * This can take 10-20 minutes
 * Enforces a minimum 10-minute wait before checking for completion
 */
export async function waitForResearchCompletion(
  runtime: CDPRuntime,
  timeoutMs: number = GEMINI_TIMEOUTS.deepResearchResponse,
  logger: BrowserLogger,
  minWaitMs: number = MIN_RESEARCH_WAIT_MS,
): Promise<DeepResearchStatus> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = GEMINI_TIMEOUTS.researchPoll;
  const startTime = Date.now();
  let lastLogTime = 0;
  const logInterval = 30_000; // Log progress every 30 seconds
  const minWaitDeadline = Date.now() + minWaitMs;

  logger(`[deep-research] Waiting for research completion (minimum ${Math.round(minWaitMs / 60000)} minutes)...`);

  while (Date.now() < deadline) {
    const now = Date.now();
    const elapsed = Math.round((now - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const withinMinWait = now < minWaitDeadline;

    // Log progress periodically
    if (now - lastLogTime > logInterval) {
      if (withinMinWait) {
        const remaining = Math.round((minWaitDeadline - now) / 1000);
        const remMin = Math.floor(remaining / 60);
        const remSec = remaining % 60;
        logger(`[deep-research] Researching... ${minutes}m ${seconds}s elapsed (${remMin}m ${remSec}s until check)`);
      } else {
        const status = await checkResearchStatus(runtime);
        logger(`[deep-research] ${status.phase}: ${minutes}m ${seconds}s elapsed`);
      }
      lastLogTime = now;
    }

    // Only check for completion after minimum wait period
    if (!withinMinWait) {
      const status = await checkResearchStatus(runtime);

      if (status.isComplete) {
        logger(`[deep-research] Research completed in ${minutes}m ${seconds}s`);
        return status;
      }

      if (status.phase === 'error') {
        logger('[deep-research] Research encountered an error');
        return status;
      }
    }

    await delay(pollInterval);
  }

  // Timeout
  logger('[deep-research] Research timed out');
  return {
    inProgress: false,
    isComplete: false,
    phase: 'error',
    message: 'Research timed out',
  };
}

/**
 * Extract research results from the immersive panel
 * Converts DOM structure directly to markdown (no raw HTML download)
 */
export async function extractResearchResults(
  runtime: CDPRuntime,
  logger: BrowserLogger,
): Promise<GeminiResponseSnapshot | null> {
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const panel = document.querySelector('deep-research-immersive-panel');
      if (!panel) return null;

      const md = panel.querySelector('.markdown-main-panel') ||
                 panel.querySelector('.markdown') ||
                 panel.querySelector('[class*="markdown"]');
      if (!md) return null;

      // Convert DOM to markdown by traversing elements (no raw HTML)
      function nodeToMarkdown(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent || '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const tag = node.tagName?.toLowerCase();
        const children = Array.from(node.childNodes).map(c => nodeToMarkdown(c)).join('');

        // Skip UI elements
        const skipTags = ['button', 'mat-icon', 'svg', 'iframe', 'response-element',
          'source-footnote', 'sources-carousel', 'sources-carousel-inline',
          'thumb-up-button', 'thumb-down-button', 'immersive-content-actions', 'web-preview'];
        if (skipTags.includes(tag)) return '';
        if (node.classList?.contains('attachment-container')) return '';
        if (node.hasAttribute?.('hide-from-message-actions')) return '';

        switch (tag) {
          case 'h1': return '# ' + children.trim() + '\\n\\n';
          case 'h2': return '## ' + children.trim() + '\\n\\n';
          case 'h3': return '### ' + children.trim() + '\\n\\n';
          case 'h4': return '#### ' + children.trim() + '\\n\\n';
          case 'p': return children.trim() + '\\n\\n';
          case 'br': return '\\n';
          case 'hr': return '---\\n\\n';
          case 'strong':
          case 'b': return '**' + children.trim() + '**';
          case 'em':
          case 'i': return '*' + children.trim() + '*';
          case 'code': return '\`' + children.trim() + '\`';
          case 'pre': return '\`\`\`\\n' + children.trim() + '\\n\`\`\`\\n\\n';
          case 'ul': return children + '\\n';
          case 'ol': return children + '\\n';
          case 'li': return '- ' + children.trim() + '\\n';
          case 'a': {
            const href = node.getAttribute('href') || '';
            return '[' + children.trim() + '](' + href + ')';
          }
          case 'code-block': {
            const codeEl = node.querySelector('code, pre');
            const code = codeEl?.textContent?.trim() || children.trim();
            const lang = node.getAttribute('language') || '';
            return '\`\`\`' + lang + '\\n' + code + '\\n\`\`\`\\n\\n';
          }
          default: return children;
        }
      }

      const markdown = nodeToMarkdown(md)
        .replace(/\\n{3,}/g, '\\n\\n')
        .replace(/^\\s+/, '')
        .trim();

      const plainText = md.textContent?.trim() || '';

      return {
        text: plainText,
        markdown: markdown,
        length: markdown.length
      };
    })()`,
    returnByValue: true,
  });

  const snapshot = result?.value as { text: string; markdown: string; length: number } | null;
  if (snapshot?.markdown) {
    logger(`[deep-research] Extracted ${snapshot.length} chars as markdown`);
    return {
      text: snapshot.text,
      html: snapshot.markdown, // Use markdown as "html" field for compatibility
    };
  }

  logger('[deep-research] Failed to extract content');
  return null;
}

/**
 * Try to copy research content using the copy button
 * Flow:
 * 1. Click "Share and export" menu button (export-menu-button)
 * 2. Wait for dropdown menu to appear
 * 3. Click "Copy contents" button inside the menu
 */
export async function tryCopyContent(
  runtime: CDPRuntime,
  logger: BrowserLogger,
): Promise<{ success: boolean; content?: string }> {
  const selectors = GEMINI_DEEP_RESEARCH_SELECTORS;

  // Step 1: Click the "Share and export" menu button
  logger('[deep-research] Looking for Share and export menu...');

  const menuOpened = await runtime.evaluate({
    expression: `(() => {
      // Primary: Export menu button by data-test-id
      const exportMenuBtn = document.querySelector('${selectors.exportMenuButton}');
      if (exportMenuBtn && exportMenuBtn instanceof HTMLElement && exportMenuBtn.offsetParent !== null) {
        exportMenuBtn.click();
        return { opened: true, selector: 'export-menu-button', text: exportMenuBtn.innerText?.trim() };
      }

      // Fallback: Look for button with "Share and export" text
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('share') && text.includes('export') && btn.offsetParent !== null) {
          btn.click();
          return { opened: true, selector: 'text-match', text: btn.innerText?.trim() };
        }
      }

      return { opened: false };
    })()`,
    returnByValue: true,
  });

  const menuResult = menuOpened.result?.value as { opened: boolean; selector?: string; text?: string } | undefined;
  if (menuResult?.opened) {
    logger(`[deep-research] Export menu opened via ${menuResult.selector}: "${menuResult.text}"`);
    await delay(600); // Wait for dropdown animation
  } else {
    logger('[deep-research] Could not find export menu button, trying direct copy');
  }

  // Step 2: Click the copy button (now visible in the dropdown)
  const { result } = await runtime.evaluate({
    expression: `(() => {
      // Find copy button - may have multiple with same test-id, find the visible one with "Copy contents" text
      const copyButtons = document.querySelectorAll('${selectors.copyButton}');
      for (const btn of copyButtons) {
        const text = btn.textContent?.trim() || '';
        // Prefer the one with "Copy contents" text (in menu)
        if (text.toLowerCase().includes('copy') && btn instanceof HTMLElement && btn.offsetParent !== null) {
          btn.click();
          return { clicked: true, method: 'copy-button-with-text', text };
        }
      }

      // Try any visible copy button
      for (const btn of copyButtons) {
        if (btn instanceof HTMLElement && btn.offsetParent !== null) {
          btn.click();
          return { clicked: true, method: 'copy-button-visible' };
        }
      }

      // Fallback: Find by aria-label
      const copyByLabel = document.querySelector('button[aria-label="Copy"]');
      if (copyByLabel && copyByLabel instanceof HTMLElement && copyByLabel.offsetParent !== null) {
        copyByLabel.click();
        return { clicked: true, method: 'aria-label' };
      }

      return { clicked: false };
    })()`,
    returnByValue: true,
  });

  const outcome = result?.value as { clicked: boolean; method?: string; text?: string } | undefined;
  if (outcome?.clicked) {
    logger(`[deep-research] Copy clicked via ${outcome.method}${outcome.text ? `: "${outcome.text}"` : ''}`);
    await delay(500);
    return { success: true };
  }

  logger('[deep-research] Could not find copy button');
  return { success: false };
}

/**
 * Trigger Export to Docs as a fallback when copy fails
 * Flow:
 * 1. Click "Share and export" menu button (if not already open)
 * 2. Click "Export to Docs" button inside the menu
 */
export async function triggerExportToDocs(
  runtime: CDPRuntime,
  logger: BrowserLogger,
): Promise<boolean> {
  const selectors = GEMINI_DEEP_RESEARCH_SELECTORS;

  // First, check if export menu is open, if not open it
  const menuCheck = await runtime.evaluate({
    expression: `(() => {
      // Check if export-to-docs button is already visible
      const exportBtn = document.querySelector('${selectors.exportToDocsButton}');
      if (exportBtn && exportBtn instanceof HTMLElement && exportBtn.offsetParent !== null) {
        return { menuOpen: true };
      }

      // Open the export menu
      const exportMenuBtn = document.querySelector('${selectors.exportMenuButton}');
      if (exportMenuBtn && exportMenuBtn instanceof HTMLElement && exportMenuBtn.offsetParent !== null) {
        exportMenuBtn.click();
        return { menuOpen: false, clicked: true };
      }

      return { menuOpen: false, clicked: false };
    })()`,
    returnByValue: true,
  });

  const menuState = menuCheck.result?.value as { menuOpen: boolean; clicked?: boolean } | undefined;
  if (menuState?.clicked) {
    await delay(600); // Wait for menu animation
  }

  // Click Export to Docs button
  const { result } = await runtime.evaluate({
    expression: `(() => {
      // Find export-to-docs button
      const exportBtns = document.querySelectorAll('${selectors.exportToDocsButton}');
      for (const btn of exportBtns) {
        if (btn instanceof HTMLElement && btn.offsetParent !== null) {
          btn.click();
          return { clicked: true, method: 'data-test-id', text: btn.innerText?.trim() };
        }
      }

      // Fallback: Find by text
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('export') && text.includes('docs') && btn.offsetParent !== null) {
          btn.click();
          return { clicked: true, method: 'text-match', text: btn.innerText?.trim() };
        }
      }

      return { clicked: false };
    })()`,
    returnByValue: true,
  });

  const outcome = result?.value as { clicked: boolean; method?: string; text?: string } | undefined;
  if (outcome?.clicked) {
    logger(`[deep-research] Export to Docs triggered via ${outcome.method}: "${outcome.text}"`);
    return true;
  }

  logger('[deep-research] Could not find Export to Docs button');
  return false;
}

/**
 * Full Deep Research flow:
 * 1. Wait for research plan
 * 2. Click Start research
 * 3. Wait for completion
 * 4. Extract and return results
 */
export async function runDeepResearchFlow(
  runtime: CDPRuntime,
  timeoutMs: number = GEMINI_TIMEOUTS.deepResearchResponse,
  logger: BrowserLogger,
): Promise<DeepResearchResult> {
  // Step 1: Wait for research plan to appear
  logger('[deep-research] Waiting for research plan...');
  const plan = await waitForResearchPlan(runtime, 30_000, logger);

  if (!plan.found) {
    throw new Error('Deep Research plan did not appear. Tool may not have activated correctly.');
  }

  // Step 2: Click Start research
  logger('[deep-research] Starting research...');
  const started = await startResearch(runtime, logger);

  if (!started) {
    throw new Error('Failed to click Start research button');
  }

  // Small delay after starting
  await delay(2000);

  // Step 3: Wait for research completion
  const status = await waitForResearchCompletion(runtime, timeoutMs, logger);

  if (!status.isComplete) {
    throw new Error(`Deep Research did not complete: ${status.message || status.phase}`);
  }

  // Step 4: Extract results
  logger('[deep-research] Extracting results...');
  const snapshot = await extractResearchResults(runtime, logger);

  if (!snapshot?.text) {
    throw new Error('Failed to extract research results');
  }

  // Step 5: Try to copy content (for markdown format)
  const copyResult = await tryCopyContent(runtime, logger);

  // If copy didn't work, try export to docs as fallback
  let exportTriggered = false;
  if (!copyResult.success) {
    exportTriggered = await triggerExportToDocs(runtime, logger);
  }

  // snapshot.html now contains markdown directly from DOM extraction
  const markdown = snapshot.html || snapshot.text;

  return {
    text: snapshot.text,
    html: undefined, // No raw HTML needed
    markdown,
    title: plan.title,
    copySucceeded: copyResult.success,
    exportTriggered,
  };
}
