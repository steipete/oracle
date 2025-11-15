import fs from 'node:fs/promises';
import type {
  BuildRequestBodyParams,
  FileContent,
  MinimalFsModule,
  OracleRequestBody,
  RunOracleOptions,
} from './types.js';
import { DEFAULT_SYSTEM_PROMPT } from './config.js';
import { createFileSections, readFiles } from './files.js';

export function buildPrompt(basePrompt: string, files: FileContent[], cwd = process.cwd()): string {
  if (!files.length) {
    return basePrompt;
  }
  const sections = createFileSections(files, cwd);
  const sectionText = sections.map((section) => section.sectionText).join('\n\n');
  return `${basePrompt.trim()}\n\n${sectionText}`;
}

export function buildRequestBody({
  modelConfig,
  systemPrompt,
  userPrompt,
  searchEnabled,
  maxOutputTokens,
  background,
  storeResponse,
}: BuildRequestBodyParams): OracleRequestBody {
  return {
    model: modelConfig.model,
    instructions: systemPrompt,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: userPrompt,
          },
        ],
      },
    ],
    tools: searchEnabled ? [{ type: 'web_search_preview' }] : undefined,
    reasoning: modelConfig.reasoning || undefined,
    max_output_tokens: maxOutputTokens,
    background: background ? true : undefined,
    store: storeResponse ? true : undefined,
  };
}

export async function renderPromptMarkdown(
  options: Pick<RunOracleOptions, 'prompt' | 'file' | 'system'>,
  deps: { cwd?: string; fs?: MinimalFsModule } = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const fsModule = deps.fs ?? (fs as unknown as MinimalFsModule);
  const files = await readFiles(options.file ?? [], { cwd, fsModule });
  const sections = createFileSections(files, cwd);
  const systemPrompt = options.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const userPrompt = (options.prompt ?? '').trim();
  const lines = ['[SYSTEM]', systemPrompt, ''];
  lines.push('[USER]', userPrompt, '');
  sections.forEach((section) => {
    lines.push(`[FILE: ${section.displayPath}]`, section.content.trimEnd(), '');
  });
  return lines.join('\n');
}
