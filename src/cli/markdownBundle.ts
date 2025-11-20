import fs from 'node:fs/promises';
import { DEFAULT_SYSTEM_PROMPT } from '../oracle/config.js';
import { buildPrompt } from '../oracle/request.js';
import { createFileSections, readFiles } from '../oracle/files.js';
import { createFsAdapter } from '../oracle/fsAdapter.js';
import type { MinimalFsModule, RunOracleOptions, FileContent } from '../oracle/types.js';

export interface MarkdownBundle {
  markdown: string;
  promptWithFiles: string;
  systemPrompt: string;
  files: FileContent[];
}

export async function buildMarkdownBundle(
  options: Pick<RunOracleOptions, 'prompt' | 'file' | 'system'>,
  deps: { cwd?: string; fs?: MinimalFsModule } = {},
): Promise<MarkdownBundle> {
  const cwd = deps.cwd ?? process.cwd();
  const fsModule = deps.fs ?? createFsAdapter(fs);
  const files = await readFiles(options.file ?? [], { cwd, fsModule });
  const sections = createFileSections(files, cwd);
  const systemPrompt = options.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const userPrompt = (options.prompt ?? '').trim();

  const lines = ['[SYSTEM]', systemPrompt, ''];
  lines.push('[USER]', userPrompt, '');
  sections.forEach((section) => {
    lines.push(`[FILE: ${section.displayPath}]`, section.content.trimEnd(), '');
  });

  const markdown = lines.join('\n');
  const promptWithFiles = buildPrompt(userPrompt, files, cwd);
  return { markdown, promptWithFiles, systemPrompt, files };
}
