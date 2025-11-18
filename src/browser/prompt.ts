import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunOracleOptions } from '../oracle.js';
import { readFiles, createFileSections, DEFAULT_SYSTEM_PROMPT, MODEL_CONFIGS, TOKENIZER_OPTIONS } from '../oracle.js';
import type { BrowserAttachment } from './types.js';

export interface BrowserPromptArtifacts {
  markdown: string;
  composerText: string;
  estimatedInputTokens: number;
  attachments: BrowserAttachment[];
  inlineFileCount: number;
  tokenEstimateIncludesInlineFiles: boolean;
  bundled?: { originalCount: number; bundlePath: string } | null;
}

interface AssemblePromptDeps {
  cwd?: string;
  readFilesImpl?: typeof readFiles;
}

export async function assembleBrowserPrompt(
  runOptions: RunOracleOptions,
  deps: AssemblePromptDeps = {},
): Promise<BrowserPromptArtifacts> {
  const cwd = deps.cwd ?? process.cwd();
  const readFilesFn = deps.readFilesImpl ?? readFiles;
  const files = await readFilesFn(runOptions.file ?? [], { cwd });
  const basePrompt = (runOptions.prompt ?? '').trim();
  const userPrompt = basePrompt;
  const systemPrompt = runOptions.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const sections = createFileSections(files, cwd);
  const lines = ['[SYSTEM]', systemPrompt, '', '[USER]', userPrompt, ''];
  sections.forEach((section) => {
    lines.push(`[FILE: ${section.displayPath}]`, section.content.trimEnd(), '');
  });
  const markdown = lines.join('\n').trimEnd();
  const inlineFiles = Boolean(runOptions.browserInlineFiles);
  const composerSections: string[] = [];
  if (systemPrompt) {
    composerSections.push(systemPrompt);
  }
  if (userPrompt) {
    composerSections.push(userPrompt);
  }
  let inlineBlock = '';
  if (inlineFiles && sections.length > 0) {
    const inlineLines: string[] = [];
    sections.forEach((section) => {
      inlineLines.push(`[FILE: ${section.displayPath}]`, section.content.trimEnd(), '');
    });
    inlineBlock = inlineLines.join('\n').trim();
    if (inlineBlock.length > 0) {
      composerSections.push(inlineBlock);
    }
  }
  const composerText = composerSections.join('\n\n').trim();
  const attachments: BrowserAttachment[] = inlineFiles
    ? []
    : sections.map((section) => ({
        path: section.absolutePath,
        displayPath: section.displayPath,
        sizeBytes: Buffer.byteLength(section.content, 'utf8'),
      }));

  const MAX_BROWSER_ATTACHMENTS = 10;
  const shouldBundle = !inlineFiles && (runOptions.browserBundleFiles || attachments.length > MAX_BROWSER_ATTACHMENTS);
  if (shouldBundle) {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-browser-bundle-'));
    const bundlePath = path.join(bundleDir, 'attachments-bundle.txt');
    const bundleLines: string[] = [];
    sections.forEach((section) => {
      bundleLines.push(`### File: ${section.displayPath}`);
      bundleLines.push(section.content.trimEnd());
      bundleLines.push('');
    });
    const bundleText = `${bundleLines.join('\n').trimEnd()}\n`;
    await fs.writeFile(bundlePath, bundleText, 'utf8');
    attachments.length = 0;
    attachments.push({
      path: bundlePath,
      displayPath: bundlePath,
      sizeBytes: Buffer.byteLength(bundleText, 'utf8'),
    });
  }
  const inlineFileCount = inlineFiles ? sections.length : 0;
  const tokenizer = MODEL_CONFIGS[runOptions.model].tokenizer;
  const tokenizerUserContent =
    inlineFileCount > 0 && inlineBlock
      ? [userPrompt, inlineBlock].filter((value) => Boolean(value?.trim())).join('\n\n').trim()
      : userPrompt;
  const tokenizerMessages = [
    systemPrompt ? { role: 'system', content: systemPrompt } : null,
    tokenizerUserContent ? { role: 'user', content: tokenizerUserContent } : null,
  ].filter(Boolean) as Array<{ role: 'system' | 'user'; content: string }>;
  const estimatedInputTokens = tokenizer(
    tokenizerMessages.length > 0
      ? tokenizerMessages
      : [{ role: 'user', content: '' }],
    TOKENIZER_OPTIONS,
  );
  const tokenEstimateIncludesInlineFiles = inlineFileCount > 0 && Boolean(inlineBlock);
  return {
    markdown,
    composerText,
    estimatedInputTokens,
    attachments,
    inlineFileCount,
    tokenEstimateIncludesInlineFiles,
    bundled:
      shouldBundle && attachments.length === 1 && attachments[0]?.displayPath
        ? { originalCount: sections.length, bundlePath: attachments[0].displayPath }
        : null,
  };
}
