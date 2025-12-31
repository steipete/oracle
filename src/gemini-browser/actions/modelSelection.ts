/**
 * Gemini Model Selection
 *
 * The Gemini UI has TWO separate selection mechanisms:
 * 1. Model Picker (Fast/Thinking/Pro) - selects the base model
 * 2. Tools Drawer (Deep Think, Create images, etc.) - activates special capabilities
 *
 * When user requests "deep-think", we need to:
 * 1. Select "Thinking" or "Pro" from the model picker
 * 2. Then activate "Deep Think" from the Tools drawer
 */

import type { ChromeClient } from '../../browser/types.js';
import type { BrowserLogger } from '../types.js';
import type { GeminiDeepThinkModel, GeminiTool } from '../constants.js';
import {
  GEMINI_MODEL_PICKER_SELECTORS,
  GEMINI_DEEP_THINK_MODELS,
  DEFAULT_GEMINI_MODEL,
} from '../constants.js';
import { delay } from '../../browser/utils.js';
import {
  ensureToolSelection,
  isDeepThinkRequested,
  isDeepResearchRequested,
} from './toolsSelection.js';

export interface ModelSelectionResult {
  modelSelected: string;
  wasChanged: boolean;
  toolActivated?: GeminiTool;
}

/**
 * Ensure the desired Gemini model/tool is selected
 *
 * This handles TWO cases:
 * 1. Regular model selection (Fast/Thinking/Pro) via model picker
 * 2. Tool activation (Deep Think, Deep Research) via Tools drawer
 *
 * For Deep Think: selects "Thinking" from picker, then activates Deep Think tool
 */
export async function ensureGeminiModelSelection(
  Runtime: ChromeClient['Runtime'],
  desiredModel: GeminiDeepThinkModel | string,
  logger: BrowserLogger,
): Promise<ModelSelectionResult> {
  // Check if this is a tool request (Deep Think, Deep Research)
  const needsDeepThink = isDeepThinkRequested(desiredModel);
  const needsDeepResearch = isDeepResearchRequested(desiredModel);

  // Determine base model for picker
  let baseModel: GeminiDeepThinkModel;
  if (needsDeepThink || needsDeepResearch) {
    // For tools, use Thinking or Pro as base
    baseModel = 'gemini-3-thinking';
  } else {
    baseModel = normalizeModelName(desiredModel);
  }

  const targetLabel = getModelLabel(baseModel);
  logger(`Selecting Gemini model: ${baseModel} (${targetLabel})`);

  // Step 1: Select base model from picker
  const currentModel = await getCurrentModel(Runtime);
  let modelChanged = false;

  if (!currentModel || !isModelMatch(currentModel, baseModel)) {
    const pickerOpened = await openModelPicker(Runtime, logger);
    if (pickerOpened) {
      await delay(300);
      const selected = await selectModelFromPicker(Runtime, baseModel, targetLabel, logger);
      if (selected) {
        logger(`Model changed to: ${baseModel}`);
        modelChanged = true;
        await delay(500);
      }
    }
  } else {
    logger(`Model already selected: ${currentModel}`);
  }

  // Step 2: Activate tool if needed (Deep Think or Deep Research)
  let toolActivated: GeminiTool | undefined;

  if (needsDeepThink) {
    logger('Activating Deep Think tool...');
    try {
      const toolResult = await ensureToolSelection(Runtime, 'deep-think', logger);
      toolActivated = 'deep-think';
      logger(`Deep Think ${toolResult.wasAlreadyActive ? 'was already active' : 'activated'}`);
    } catch (error) {
      logger(`Warning: Could not activate Deep Think: ${error instanceof Error ? error.message : error}`);
    }
  } else if (needsDeepResearch) {
    logger('Activating Deep Research tool...');
    try {
      const toolResult = await ensureToolSelection(Runtime, 'deep-research', logger);
      toolActivated = 'deep-research';
      logger(`Deep Research ${toolResult.wasAlreadyActive ? 'was already active' : 'activated'}`);
    } catch (error) {
      logger(`Warning: Could not activate Deep Research: ${error instanceof Error ? error.message : error}`);
    }
  }

  return {
    modelSelected: toolActivated ? `${baseModel}+${toolActivated}` : baseModel,
    wasChanged: modelChanged || toolActivated !== undefined,
    toolActivated,
  };
}

/**
 * Get the current selected model
 */
async function getCurrentModel(Runtime: ChromeClient['Runtime']): Promise<string | null> {
  const selectorsJson = JSON.stringify(GEMINI_MODEL_PICKER_SELECTORS);

  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const selectors = ${selectorsJson};

      // Try to find model indicator
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          const text = el.textContent?.trim() || el.getAttribute('aria-label') || '';
          if (text) return text;
        }
      }

      // Try to find model name in header or UI
      const modelIndicators = document.querySelectorAll(
        '[data-model], [data-testid*="model"], .model-name, .model-indicator'
      );
      for (const el of modelIndicators) {
        const text = el.textContent?.trim() || el.getAttribute('data-model') || '';
        if (text) return text;
      }

      return null;
    })()`,
    returnByValue: true,
  });

  return typeof result?.value === 'string' ? result.value : null;
}

/**
 * Open the model picker dropdown
 */
async function openModelPicker(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
): Promise<boolean> {
  const selectorsJson = JSON.stringify(GEMINI_MODEL_PICKER_SELECTORS);

  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const selectors = ${selectorsJson};

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && el instanceof HTMLElement) {
          el.click();
          return { clicked: true, selector };
        }
      }

      // Try generic approach: find button with model-related text
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes('gemini') || text.includes('model') || text.includes('pro') || text.includes('flash')) {
          btn.click();
          return { clicked: true, selector: 'button-text-match' };
        }
      }

      return { clicked: false };
    })()`,
    returnByValue: true,
  });

  const outcome = result?.value as { clicked?: boolean; selector?: string } | undefined;

  if (outcome?.clicked) {
    logger(`Opened model picker via ${outcome.selector}`);
    return true;
  }

  return false;
}

/**
 * Select a model from the open picker menu
 */
async function selectModelFromPicker(
  Runtime: ChromeClient['Runtime'],
  modelId: GeminiDeepThinkModel,
  targetLabel: string,
  logger: BrowserLogger,
): Promise<boolean> {
  // Build list of search terms
  const searchTerms = [
    modelId,
    targetLabel,
    targetLabel.toLowerCase(),
    ...getModelSearchTerms(modelId),
  ];
  const searchTermsJson = JSON.stringify(searchTerms);

  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const searchTerms = ${searchTermsJson};

      // Find menu items
      const menuItems = Array.from(document.querySelectorAll(
        '[role="menuitem"], [role="option"], [role="listitem"], ' +
        '[data-testid*="model"], .model-option, button[data-value]'
      ));

      // Also check general buttons/links in any open menu
      const menuContainer = document.querySelector('[role="menu"], [role="listbox"], .dropdown-menu');
      if (menuContainer) {
        menuItems.push(...Array.from(menuContainer.querySelectorAll('button, a, [role="button"]')));
      }

      for (const item of menuItems) {
        const text = (item.textContent || '').toLowerCase();
        const value = item.getAttribute('data-value') || item.getAttribute('data-model') || '';

        for (const term of searchTerms) {
          if (text.includes(term.toLowerCase()) || value.toLowerCase().includes(term.toLowerCase())) {
            if (item instanceof HTMLElement) {
              item.click();
              return { selected: true, text: item.textContent?.trim() };
            }
          }
        }
      }

      return { selected: false };
    })()`,
    returnByValue: true,
  });

  const outcome = result?.value as { selected?: boolean; text?: string } | undefined;

  if (outcome?.selected) {
    logger(`Selected model: ${outcome.text ?? modelId}`);
    return true;
  }

  return false;
}

/**
 * Normalize model name to internal format
 */
function normalizeModelName(model: string): GeminiDeepThinkModel {
  const normalized = model.toLowerCase().trim();

  // Direct match
  if (normalized in GEMINI_DEEP_THINK_MODELS) {
    return normalized as GeminiDeepThinkModel;
  }

  // Tool requests (handled separately, but normalize to base model)
  if (normalized.includes('deep') && normalized.includes('think')) {
    return 'gemini-deep-think'; // Will trigger tool activation
  }
  if (normalized.includes('deep') && normalized.includes('research')) {
    return 'gemini-deep-research'; // Will trigger tool activation
  }

  // Model picker options
  if (normalized.includes('fast') || normalized.includes('flash')) {
    return 'gemini-3-fast';
  }
  if (normalized.includes('thinking') || normalized === 'thinking') {
    return 'gemini-3-thinking';
  }
  if (normalized.includes('3') && normalized.includes('pro')) {
    return 'gemini-3-pro';
  }
  if (normalized.includes('2.5') && normalized.includes('flash')) {
    return 'gemini-2.5-flash';
  }
  if (normalized.includes('2.5') && normalized.includes('pro')) {
    return 'gemini-2.5-pro';
  }
  if (normalized.includes('pro')) {
    return 'gemini-3-pro';
  }

  return DEFAULT_GEMINI_MODEL;
}

/**
 * Get display label for model
 */
function getModelLabel(model: GeminiDeepThinkModel): string {
  return GEMINI_DEEP_THINK_MODELS[model] ?? model;
}

/**
 * Get search terms for model selection
 */
function getModelSearchTerms(model: GeminiDeepThinkModel): string[] {
  switch (model) {
    case 'gemini-2.5-pro':
      return ['2.5 pro', '2.5-pro', 'gemini pro'];
    case 'gemini-2.5-flash':
      return ['2.5 flash', '2.5-flash', 'flash', 'gemini flash'];
    case 'gemini-3-pro':
      return ['pro', '3 pro', '3-pro', 'gemini 3 pro'];
    case 'gemini-3-fast':
      return ['fast', '3 fast', 'flash'];
    case 'gemini-3-thinking':
      return ['thinking', '3 thinking'];
    case 'gemini-deep-think':
    case 'deep-think':
      return ['thinking']; // Select Thinking from picker, tool handled separately
    case 'gemini-deep-research':
      return ['thinking']; // Select Thinking from picker, tool handled separately
    default:
      return [model];
  }
}

/**
 * Check if current model matches desired model
 */
function isModelMatch(current: string, desired: GeminiDeepThinkModel): boolean {
  const currentLower = current.toLowerCase();
  const desiredLower = desired.toLowerCase();

  // Direct match
  if (currentLower.includes(desiredLower)) {
    return true;
  }

  // Check label match
  const label = getModelLabel(desired).toLowerCase();
  if (currentLower.includes(label)) {
    return true;
  }

  // Check search terms
  const terms = getModelSearchTerms(desired);
  return terms.some((term) => currentLower.includes(term.toLowerCase()));
}
