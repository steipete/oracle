import type { RunOracleOptions } from '../oracle.js';
import { readFiles, buildPrompt, createFileSections, DEFAULT_SYSTEM_PROMPT, MODEL_CONFIGS, TOKENIZER_OPTIONS } from '../oracle.js';

export interface BrowserPromptArtifacts {
  markdown: string;
  estimatedInputTokens: number;
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
  const userPrompt = buildPrompt(runOptions.prompt, files, cwd);
  const systemPrompt = runOptions.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const sections = createFileSections(files, cwd);
  const lines = ['[SYSTEM]', systemPrompt, '', '[USER]', userPrompt, ''];
  sections.forEach((section) => {
    lines.push(`[FILE: ${section.displayPath}]`, section.content.trimEnd(), '');
  });
  const markdown = lines.join('\n').trimEnd();
  const tokenizer = MODEL_CONFIGS[runOptions.model].tokenizer;
  const estimatedInputTokens = tokenizer(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    TOKENIZER_OPTIONS,
  );
  return { markdown, estimatedInputTokens };
}
