import chalk from 'chalk';
import OpenAI from 'openai';
import { countTokens as countTokensGpt5 } from 'gpt-tokenizer/model/gpt-5';
import { countTokens as countTokensGpt5Pro } from 'gpt-tokenizer/model/gpt-5-pro';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

type TokenizerFn = (input: unknown, options?: Record<string, unknown>) => number;

export type ModelName = 'gpt-5-pro' | 'gpt-5.1';

interface ModelConfig {
  model: ModelName;
  tokenizer: TokenizerFn;
  inputLimit: number;
  pricing: {
    inputPerToken: number;
    outputPerToken: number;
  };
  reasoning: { effort: 'high' } | null;
}

export interface FileContent {
  path: string;
  content: string;
}

interface FileSection {
  index: number;
  absolutePath: string;
  displayPath: string;
  sectionText: string;
  content: string;
}

interface FsStats {
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface MinimalFsModule {
  stat(targetPath: string): Promise<FsStats>;
  readdir(targetPath: string): Promise<string[]>;
  readFile(targetPath: string, encoding: NodeJS.BufferEncoding): Promise<string>;
}

interface FileTokenEntry {
  path: string;
  displayPath: string;
  tokens: number;
  percent?: number;
}

interface FileTokenStats {
  stats: FileTokenEntry[];
  totalTokens: number;
}

export type PreviewMode = 'summary' | 'json' | 'full';

export interface ResponseStreamEvent {
  type: string;
  delta?: string;
  [key: string]: unknown;
}

export interface ResponseStreamLike extends AsyncIterable<ResponseStreamEvent> {
  finalResponse(): Promise<OracleResponse>;
  abort?: () => void;
}

export interface ClientLike {
  responses: {
    stream(body: OracleRequestBody): Promise<ResponseStreamLike> | ResponseStreamLike;
  };
}

export interface RunOracleOptions {
  prompt: string;
  model: ModelName;
  file?: string[];
  slug?: string;
  filesReport?: boolean;
  maxInput?: number;
  maxOutput?: number;
  system?: string;
  silent?: boolean;
  search?: boolean;
  preview?: boolean | string;
  previewMode?: PreviewMode;
  apiKey?: string;
  sessionId?: string;
  verbose?: boolean;
}

interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

interface PreviewResult {
  mode: 'preview';
  previewMode: PreviewMode;
  requestBody: OracleRequestBody;
  estimatedInputTokens: number;
  inputTokenBudget: number;
}

interface LiveResult {
  mode: 'live';
  response: OracleResponse;
  usage: UsageSummary;
  elapsedMs: number;
}

export type RunOracleResult = PreviewResult | LiveResult;

export interface RunOracleDeps {
  apiKey?: string;
  cwd?: string;
  fs?: MinimalFsModule;
  log?: (message: string) => void;
  write?: (chunk: string) => boolean;
  now?: () => number;
  clientFactory?: (apiKey: string) => ClientLike;
  client?: ClientLike;
}

interface BuildRequestBodyParams {
  modelConfig: ModelConfig;
  systemPrompt: string;
  userPrompt: string;
  searchEnabled: boolean;
  maxOutputTokens?: number;
}

interface ToolConfig {
  type: 'web_search_preview';
}

export interface OracleRequestBody {
  model: string;
  instructions: string;
  input: Array<{
    role: 'user';
    content: Array<{
      type: 'input_text';
      text: string;
    }>;
  }>;
  tools?: ToolConfig[];
  reasoning?: { effort: 'high' };
  max_output_tokens?: number;
}

interface ResponseContentPart {
  type?: string;
  text?: string;
}

interface ResponseOutputItem {
  type?: string;
  content?: ResponseContentPart[];
  text?: string;
}

export interface OracleResponse {
  status?: string;
  error?: { message?: string };
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
  };
  output_text?: string[];
  output?: ResponseOutputItem[];
}

const pkgPath = resolvePackageJsonPath(import.meta.url);
const require = createRequire(import.meta.url);
const pkg = require(pkgPath);

function resolvePackageJsonPath(moduleUrl: string): string {
  const startDir = path.dirname(fileURLToPath(moduleUrl));
  return resolveFromDir(startDir);

  function resolveFromDir(dir: string): string {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      throw new Error('Unable to locate package.json from module path.');
    }
    return resolveFromDir(parentDir);
  }
}

export const MODEL_CONFIGS: Record<ModelName, ModelConfig> = {
  'gpt-5-pro': {
    model: 'gpt-5-pro',
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 15 / 1_000_000,
      outputPerToken: 120 / 1_000_000,
    },
    reasoning: null,
  },
  'gpt-5.1': {
    model: 'gpt-5.1',
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 1.25 / 1_000_000,
      outputPerToken: 10 / 1_000_000,
    },
    reasoning: { effort: 'high' },
  },
};

import kleur from 'kleur';

export const DEFAULT_SYSTEM_PROMPT = [
  'You are Oracle, a focused one-shot problem solver.',
  'Emphasize direct answers, cite any files referenced, and clearly note when the search tool was used.',
].join(' ');
const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);

export const TOKENIZER_OPTIONS = { allowedSpecial: 'all' } as const;

export function collectPaths(value: string | string[] | undefined, previous: string[] = []): string[] {
  if (!value) {
    return previous;
  }
  const nextValues = Array.isArray(value) ? value : [value];
  return previous
    .concat(nextValues.flatMap((entry) => entry.split(',')))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseIntOption(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error('Value must be an integer.');
  }
  return parsed;
}

async function expandToFiles(targetPath: string, fsModule: MinimalFsModule): Promise<string[]> {
  let stats: FsStats;
  try {
    stats = await fsModule.stat(targetPath);
  } catch (_error) {
    throw new Error(`Missing file or directory: ${targetPath}`);
  }
  if (stats.isFile()) {
    return [targetPath];
  }
  if (stats.isDirectory()) {
    const entries = await fsModule.readdir(targetPath);
    const nestedFiles = await Promise.all(
      entries.map((entry) => expandToFiles(path.join(targetPath, entry), fsModule)),
    );
    return nestedFiles.flat();
  }
  throw new Error(`Not a file or directory: ${targetPath}`);
}

export async function readFiles(
  filePaths: string[],
  { cwd = process.cwd(), fsModule = fs as MinimalFsModule } = {},
): Promise<FileContent[]> {
  const files: FileContent[] = [];
  const seen = new Set<string>();
  for (const rawPath of filePaths) {
    const absolutePath = path.resolve(cwd, rawPath);
    const expandedPaths = await expandToFiles(absolutePath, fsModule);
    for (const concretePath of expandedPaths) {
      if (seen.has(concretePath)) {
        continue;
      }
      seen.add(concretePath);
      const content = await fsModule.readFile(concretePath, 'utf8');
      files.push({ path: concretePath, content });
    }
  }
  return files;
}

export function createFileSections(files: FileContent[], cwd = process.cwd()): FileSection[] {
  return files.map((file, index) => {
    const relative = path.relative(cwd, file.path) || file.path;
    const sectionText = [
      `### File ${index + 1}: ${relative}`,
      '```',
      file.content.trimEnd(),
      '```',
    ].join('\n');
    return {
      index: index + 1,
      absolutePath: file.path,
      displayPath: relative,
      sectionText,
      content: file.content,
    };
  });
}

export function buildPrompt(basePrompt: string, files: FileContent[], cwd = process.cwd()): string {
  if (!files.length) {
    return basePrompt.trim();
  }
  const sections = createFileSections(files, cwd);
  return `${basePrompt.trim()}\n\n### Attached Files\n${sections.map((section) => section.sectionText).join('\n\n')}`;
}

export function extractTextOutput(response: OracleResponse): string {
  if (Array.isArray(response.output_text) && response.output_text.length > 0) {
    return response.output_text.join('\n').trim();
  }
  if (!Array.isArray(response.output)) {
    return '';
  }
  const textChunks = [];
  for (const item of response.output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const contentItem of item.content) {
        if (typeof contentItem?.text === 'string') {
          textChunks.push(contentItem.text);
        }
      }
    } else if (item?.type === 'output_text' && typeof item.text === 'string') {
      textChunks.push(item.text);
    }
  }
  return textChunks.join('\n').trim();
}

export function formatUSD(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  if (value >= 0.1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(3)}`;
  }
  return `$${value.toFixed(6)}`;
}

export function formatNumber(
  value: number | null | undefined,
  { estimated = false }: { estimated?: boolean } = {},
): string {
  if (value == null) {
    return 'n/a';
  }
  const suffix = estimated ? ' (est.)' : '';
  return `${value.toLocaleString()}${suffix}`;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(2)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  let seconds = Math.round(totalSeconds - minutes * 60);
  let adjustedMinutes = minutes;
  if (seconds === 60) {
    adjustedMinutes += 1;
    seconds = 0;
  }
  return `${adjustedMinutes}m ${seconds}s`;
}

export function getFileTokenStats(
  files: FileContent[],
  {
    cwd = process.cwd(),
    tokenizer,
    tokenizerOptions,
    inputTokenBudget,
  }: {
    cwd?: string;
    tokenizer: TokenizerFn;
    tokenizerOptions: Record<string, unknown>;
    inputTokenBudget?: number;
  },
): FileTokenStats {
  if (!files.length) {
    return { stats: [], totalTokens: 0 };
  }
  const sections = createFileSections(files, cwd);
  const stats = sections
    .map((section) => {
      const tokens = tokenizer(section.sectionText, tokenizerOptions);
      const percent = inputTokenBudget ? (tokens / inputTokenBudget) * 100 : undefined;
      return {
        path: section.absolutePath,
        displayPath: section.displayPath,
        tokens,
        percent,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
  const totalTokens = stats.reduce((sum, entry) => sum + entry.tokens, 0);
  return { stats, totalTokens };
}

export function printFileTokenStats(
  { stats, totalTokens }: FileTokenStats,
  { inputTokenBudget, log = console.log }: { inputTokenBudget?: number; log?: (message: string) => void },
): void {
  if (!stats.length) {
    return;
  }
  log(chalk.bold('File Token Usage'));
  for (const entry of stats) {
    const percentLabel =
      inputTokenBudget && entry.percent != null ? `${entry.percent.toFixed(2)}%` : 'n/a';
    log(`${entry.tokens.toLocaleString().padStart(10)}  ${percentLabel.padStart(8)}  ${entry.displayPath}`);
  }
  if (inputTokenBudget) {
    const totalPercent = (totalTokens / inputTokenBudget) * 100;
    log(
      `Total: ${totalTokens.toLocaleString()} tokens (${totalPercent.toFixed(
        2,
      )}% of ${inputTokenBudget.toLocaleString()})`,
    );
  } else {
    log(`Total: ${totalTokens.toLocaleString()} tokens`);
  }
}

export function buildRequestBody({
  modelConfig,
  systemPrompt,
  userPrompt,
  searchEnabled,
  maxOutputTokens,
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
  };
}

function createDefaultClientFactory(): (apiKey: string) => ClientLike {
  return (key: string): ClientLike => {
    const instance = new OpenAI({
      apiKey: key,
      timeout: 15 * 60 * 1000,
    });
    return {
      responses: {
        stream: (body: OracleRequestBody) =>
          instance.responses.stream(body) as unknown as ResponseStreamLike,
      },
    };
  };
}

export async function runOracle(options: RunOracleOptions, deps: RunOracleDeps = {}): Promise<RunOracleResult> {
  const {
    apiKey = options.apiKey ?? process.env.OPENAI_API_KEY,
    cwd = process.cwd(),
    fs: fsModule = fs as MinimalFsModule,
    log = console.log,
    write = (text: string) => process.stdout.write(text),
    now = () => performance.now(),
    clientFactory = createDefaultClientFactory(),
    client,
  } = deps;
  const verbose = Boolean(options.verbose);
  const logVerbose = (message: string): void => {
    if (verbose) {
      log(dim(`[verbose] ${message}`));
    }
  };

  const allowedPreviewModes = new Set(['summary', 'json', 'full']);
  const previewSource = options.previewMode ?? options.preview;
  let previewMode: PreviewMode | undefined;
  if (typeof previewSource === 'string' && previewSource.length > 0) {
    previewMode = allowedPreviewModes.has(previewSource)
      ? (previewSource as PreviewMode)
      : 'summary';
  } else if (previewSource) {
    previewMode = 'summary';
  }
  const isPreview = Boolean(previewMode);

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY. Set it via the environment or a .env file.');
  }

  const modelConfig = MODEL_CONFIGS[options.model];
  if (!modelConfig) {
    throw new Error(`Unsupported model "${options.model}". Choose one of: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
  }

  const inputTokenBudget = options.maxInput ?? modelConfig.inputLimit;
  const files = await readFiles(options.file ?? [], { cwd, fsModule });
  logVerbose(`cwd: ${cwd}`);
  if (files.length > 0) {
    const displayPaths = files
      .map((file) => path.relative(cwd, file.path) || file.path)
      .slice(0, 10)
      .join(', ');
    const extra = files.length > 10 ? ` (+${files.length - 10} more)` : '';
    logVerbose(`Attached files (${files.length}): ${displayPaths}${extra}`);
  } else {
    logVerbose('No files attached.');
  }
  const fileTokenInfo = getFileTokenStats(files, {
    cwd,
    tokenizer: modelConfig.tokenizer,
    tokenizerOptions: TOKENIZER_OPTIONS,
    inputTokenBudget,
  });
  const userPrompt = buildPrompt(options.prompt, files, cwd);
  const systemPrompt = options.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const estimatedInputTokens = modelConfig.tokenizer(messages, TOKENIZER_OPTIONS);
  const fileCount = files.length;
  const headerLine = `Oracle (${pkg.version}) consulting ${modelConfig.model}'s crystal ball with ${estimatedInputTokens.toLocaleString()} tokens and ${fileCount} files...`;

  if (!isPreview) {
    log(headerLine);
    if (options.model === 'gpt-5-pro') {
      log(dim('Pro is thinking, this can take up to 10 minutes...'));
    }
    log(dim('Press Ctrl+C to cancel.'));
  }
  const shouldReportFiles =
    (options.filesReport || fileTokenInfo.totalTokens > inputTokenBudget) &&
    fileTokenInfo.stats.length > 0;
  logVerbose(
    `Search: ${options.search !== false ? 'enabled' : 'disabled'} | Max output tokens: ${
      options.maxOutput ?? 'model-default'
    }`,
  );
  logVerbose(
    `Input tokens estimate: ${estimatedInputTokens.toLocaleString()} / ${inputTokenBudget.toLocaleString()}`,
  );
  if (shouldReportFiles) {
    printFileTokenStats(fileTokenInfo, { inputTokenBudget, log });
  }

  if (estimatedInputTokens > inputTokenBudget) {
    throw new Error(
      `Input too large (${estimatedInputTokens.toLocaleString()} tokens). Limit is ${inputTokenBudget.toLocaleString()} tokens.`,
    );
  }

  const requestBody = buildRequestBody({
    modelConfig,
    systemPrompt,
    userPrompt,
    searchEnabled: true,
    maxOutputTokens: options.maxOutput,
  });

  if (previewMode) {
    if (previewMode === 'json' || previewMode === 'full') {
      log(chalk.bold('Request JSON'));
      log(JSON.stringify(requestBody, null, 2));
      log('');
    }
    if (previewMode === 'full') {
      log(chalk.bold('Assembled Prompt'));
      log(userPrompt);
      log('');
    }
    log(
      `Estimated input tokens: ${estimatedInputTokens.toLocaleString()} / ${inputTokenBudget.toLocaleString()} (model: ${modelConfig.model})`,
    );
    return {
      mode: 'preview',
      previewMode,
      requestBody,
      estimatedInputTokens,
      inputTokenBudget,
    };
  }

  const openAiClient: ClientLike = client ?? clientFactory(apiKey);
  logVerbose('Dispatching request to OpenAI Responses API...');

  const runStart = now();
  const stream: ResponseStreamLike = await openAiClient.responses.stream(requestBody);

  let sawTextDelta = false;

  let answerHeaderPrinted = false;
  const ensureAnswerHeader = () => {
    if (!options.silent && !answerHeaderPrinted) {
      log(chalk.bold('Answer:'));
      answerHeaderPrinted = true;
    }
  };

  try {
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        sawTextDelta = true;
        ensureAnswerHeader();
        if (!options.silent && typeof event.delta === 'string') {
          write(event.delta);
        }
      }
    }
  } catch (streamError) {
    if (typeof stream.abort === 'function') {
      stream.abort();
    }
    throw streamError;
  }

  const response = await stream.finalResponse();
  logVerbose(`Response status: ${response.status ?? 'completed'}`);
  const elapsedMs = now() - runStart;

  if (response.status && response.status !== 'completed') {
    const detail = response.error?.message || response.incomplete_details?.reason || response.status;
    throw new Error(`Response did not complete: ${detail}`);
  }

  const answerText = extractTextOutput(response);
  if (!options.silent) {
    // biome-ignore lint/nursery/noUnnecessaryConditions: flag flips when streaming text arrives
    if (sawTextDelta) {
      write('\n\n');
    } else {
      ensureAnswerHeader();
      log(answerText || chalk.dim('(no text output)'));
      log('');
    }
  }

  const usage = response.usage ?? {};
  const inputTokens = usage.input_tokens ?? estimatedInputTokens;
  const outputTokens = usage.output_tokens ?? 0;
  const reasoningTokens = usage.reasoning_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens + reasoningTokens;
  const cost = inputTokens * modelConfig.pricing.inputPerToken + outputTokens * modelConfig.pricing.outputPerToken;

  const elapsedDisplay = formatElapsed(elapsedMs);
  const statsParts: string[] = [];
  const modelLabel = modelConfig.model + (modelConfig.reasoning ? '[high]' : '');
  statsParts.push(modelLabel);
  statsParts.push(formatUSD(cost));
  const tokensDisplay = [inputTokens, outputTokens, reasoningTokens, totalTokens]
    .map((value, index) => {
      const estimatedFlag =
        (index === 0 && usage.input_tokens == null) ||
        (index === 1 && usage.output_tokens == null) ||
        (index === 2 && usage.reasoning_tokens == null) ||
        (index === 3 && usage.total_tokens == null);
      const valueText = value.toLocaleString();
      return estimatedFlag ? `${valueText}*` : valueText;
    })
    .join('/');
  statsParts.push(`tok(i/o/r/t)=${tokensDisplay}`);
  if (!options.search) {
    statsParts.push('search=off');
  }
  if (files.length > 0) {
    statsParts.push(`files=${files.length}`);
  }
  log(chalk.blue(`Finished in ${elapsedDisplay} (${statsParts.join(' | ')})`));

  return {
    mode: 'live',
    response,
    usage: { inputTokens, outputTokens, reasoningTokens, totalTokens },
    elapsedMs,
  };
}

export async function renderPromptMarkdown(
  options: Pick<RunOracleOptions, 'prompt' | 'file' | 'system'>,
  deps: { cwd?: string; fs?: MinimalFsModule } = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const fsModule = deps.fs ?? (fs as MinimalFsModule);
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
