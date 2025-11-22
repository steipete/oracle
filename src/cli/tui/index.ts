import chalk from 'chalk';
import inquirer, { type DistinctQuestion } from 'inquirer';
import kleur from 'kleur';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { DEFAULT_MODEL, MODEL_CONFIGS, type ModelName, type RunOracleOptions } from '../../oracle.js';
import { renderMarkdownAnsi } from '../markdownRenderer.js';
import type { SessionMetadata, SessionMode, BrowserSessionConfig, SessionModelRun } from '../../sessionStore.js';
import { sessionStore, pruneOldSessions } from '../../sessionStore.js';
import { performSessionRun } from '../sessionRunner.js';
import { MAX_RENDER_BYTES, trimBeforeFirstAnswer } from '../sessionDisplay.js';
import { buildBrowserConfig, resolveBrowserModelLabel } from '../browserConfig.js';
import { resolveNotificationSettings } from '../notifier.js';
import { loadUserConfig, type UserConfig } from '../../config.js';

const isTty = (): boolean => Boolean(process.stdout.isTTY && chalk.level > 0);
const dim = (text: string): string => (isTty() ? kleur.dim(text) : text);

const RECENT_WINDOW_HOURS = 24;
const PAGE_SIZE = 10;
const STATUS_PAD = 9;
const MODEL_PAD = 13;
const MODE_PAD = 7;
const TIMESTAMP_PAD = 19;
const CHARS_PAD = 5;
const COST_PAD = 7;

type SessionChoice = { name: string; value: string };
type Choice =
  | SessionChoice
  | inquirer.Separator
  | (SessionChoice & { disabled?: boolean });

export interface LaunchTuiOptions {
  version: string;
  printIntro?: boolean;
}

export async function launchTui({ version, printIntro = true }: LaunchTuiOptions): Promise<void> {
  const userConfig = (await loadUserConfig()).config;
  const rich = isTty();
  if (printIntro) {
    if (rich) {
      console.log(chalk.bold('🧿 oracle'), `${version}`, dim('— Whispering your tokens to the silicon sage'));
    } else {
      console.log(`🧿 oracle ${version} — Whispering your tokens to the silicon sage`);
    }
  }
  console.log('');
  let showingOlder = false;
  for (;;) {
    const { recent, older, olderTotal } = await fetchSessionBuckets();
    const choices: Choice[] = [];

    const headerLabel = dim(
      `${'Status'.padEnd(STATUS_PAD)} ${'Model'.padEnd(MODEL_PAD)} ${'Mode'.padEnd(MODE_PAD)} ${'Timestamp'.padEnd(
        TIMESTAMP_PAD,
      )} ${'Chars'.padStart(CHARS_PAD)} ${'Cost'.padStart(COST_PAD)}  Slug`,
    );

    // Start with a selectable row so focus never lands on a separator
    choices.push({ name: chalk.bold.green('ask oracle'), value: '__ask__' });

    if (!showingOlder) {
      if (recent.length > 0) {
        choices.push(new inquirer.Separator(headerLabel));
        choices.push(...recent.map(toSessionChoice));
      } else if (older.length > 0) {
        // No recent entries; show first page of older.
        choices.push(new inquirer.Separator(headerLabel));
        choices.push(...older.slice(0, PAGE_SIZE).map(toSessionChoice));
      }
    } else if (older.length > 0) {
      choices.push(new inquirer.Separator(headerLabel));
      choices.push(...older.map(toSessionChoice));
    }

    choices.push(new inquirer.Separator(' '));
    choices.push(new inquirer.Separator('Actions'));
    choices.push({ name: chalk.bold.green('ask oracle'), value: '__ask__' });

    if (!showingOlder && olderTotal > 0) {
      choices.push({ name: 'Older page', value: '__older__' });
    } else {
      choices.push({ name: 'Newer (recent)', value: '__reset__' });
    }

    choices.push({ name: 'Exit', value: '__exit__' });

    const selection = await new Promise<string>((resolve) => {
      const prompt = inquirer.prompt<{ selection: string }>([
        {
          name: 'selection',
          type: 'list',
          message: 'Select a session or action',
          choices,
          pageSize: 16,
          loop: false,
        },
      ]);

      prompt
        .then(({ selection: answer }) => resolve(answer))
        .catch((error) => {
          console.error(
            chalk.red('Paging failed; returning to recent list.'),
            error instanceof Error ? error.message : error,
          );
          resolve('__reset__');
        });
    });

    if (selection === '__exit__') {
      console.log(chalk.green('🧿 Closing the book. See you next prompt.'));
      return;
    }
    if (selection === '__ask__') {
      await askOracleFlow(version, userConfig);
      continue;
    }
    if (selection === '__older__') {
      showingOlder = true;
      continue;
    }
    if (selection === '__reset__') {
      showingOlder = false;
      continue;
    }

    await showSessionDetail(selection);
  }
}

async function fetchSessionBuckets(): Promise<{
  recent: SessionMetadata[];
  older: SessionMetadata[];
  hasMoreOlder: boolean;
  olderTotal: number;
}> {
  const all = await sessionStore.listSessions();
  const cutoff = Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000;
  const recent = all.filter((meta) => new Date(meta.createdAt).getTime() >= cutoff).slice(0, PAGE_SIZE);
  const olderAll = all.filter((meta) => new Date(meta.createdAt).getTime() < cutoff);
  const older = olderAll.slice(0, PAGE_SIZE);
  const hasMoreOlder = olderAll.length > PAGE_SIZE;

  if (recent.length === 0 && older.length === 0 && olderAll.length > 0) {
    // No recent entries; fall back to top 10 overall.
    return { recent: olderAll.slice(0, PAGE_SIZE), older: [], hasMoreOlder: olderAll.length > PAGE_SIZE, olderTotal: olderAll.length };
  }
  return { recent, older, hasMoreOlder, olderTotal: olderAll.length };
}

function toSessionChoice(meta: SessionMetadata): SessionChoice {
  return {
    name: formatSessionLabel(meta),
    value: meta.id,
  };
}

function formatSessionLabel(meta: SessionMetadata): string {
  const status = colorStatus(meta.status ?? 'unknown');
  const created = formatTimestampAligned(meta.createdAt);
  const model = meta.model ?? 'n/a';
  const mode = meta.mode ?? meta.options?.mode ?? 'api';
  const slug = meta.id;
  const chars = meta.options?.prompt?.length ?? meta.promptPreview?.length ?? 0;
  const charLabel = chars > 0 ? chalk.gray(String(chars).padStart(CHARS_PAD)) : chalk.gray(`${''.padStart(CHARS_PAD - 1)}-`);
  const cost = mode === 'browser' ? null : resolveCost(meta);
  const costLabel = cost != null ? chalk.gray(formatCostTable(cost)) : chalk.gray(`${''.padStart(COST_PAD - 1)}-`);
  return `${status} ${chalk.white(model.padEnd(MODEL_PAD))} ${chalk.gray(mode.padEnd(MODE_PAD))} ${chalk.gray(created.padEnd(
    TIMESTAMP_PAD,
  ))} ${charLabel} ${costLabel}  ${chalk.cyan(
    slug,
  )}`;
}

function resolveCost(meta: SessionMetadata): number | null {
  if (meta.usage?.cost != null) {
    return meta.usage.cost;
  }
  if (!meta.model || !meta.usage) {
    return null;
  }
  const pricing = MODEL_CONFIGS[meta.model as keyof typeof MODEL_CONFIGS]?.pricing;
  if (!pricing) return null;
  const input = meta.usage.inputTokens ?? 0;
  const output = meta.usage.outputTokens ?? 0;
  const cost = input * pricing.inputPerToken + output * pricing.outputPerToken;
  return cost > 0 ? cost : null;
}

function formatCostTable(cost: number): string {
  return `$${cost.toFixed(3)}`.padStart(COST_PAD);
}

function formatTimestampAligned(iso: string): string {
  const date = new Date(iso);
  const locale = 'en-US';
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: undefined,
    hour12: true,
  };
  let formatted = date.toLocaleString(locale, opts);
  // Drop the comma and use double-space between date and time for alignment.
  formatted = formatted.replace(', ', '  ');
  // Insert a leading space when hour is a single digit to align AM/PM column.
  // Example: "11/18/2025  1:07 AM" -> "11/18/2025   1:07 AM"
  return formatted.replace(/(\s)(\d:)/, '$1 $2');
}

function colorStatus(status: string): string {
  const padded = status.padEnd(9);
  switch (status) {
    case 'completed':
      return chalk.green(padded);
    case 'error':
      return chalk.red(padded);
    case 'running':
      return chalk.yellow(padded);
    default:
      return padded;
  }
}

async function showSessionDetail(sessionId: string): Promise<void> {
  for (;;) {
    const meta = await readSessionMetadataSafe(sessionId);
    if (!meta) {
      console.log(chalk.red(`No session found with ID ${sessionId}`));
      return;
    }
    console.clear();
    printSessionHeader(meta);
    if (meta.models && meta.models.length > 0) {
      printModelSummaries(meta.models);
    }
    const prompt = await readStoredPrompt(sessionId);
    if (prompt) {
      console.log(chalk.bold('Prompt:'));
      console.log(renderMarkdownAnsi(prompt));
      console.log(dim('---'));
    }
    const logPath = await getSessionLogPath(sessionId);
    if (logPath) {
      console.log(dim(`Log file: ${logPath}`));
    }
    console.log('');

    await renderSessionLog(sessionId);

    const isRunning = meta.status === 'running';
    const modelActions =
      meta.models?.map((run) => ({
        name: `View ${run.model} log (${run.status})`,
        value: `log:${run.model}`,
      })) ?? [];
    const actions: Array<{ name: string; value: string }> = [
      { name: 'View combined log', value: 'log:__all__' },
      ...modelActions,
      ...(isRunning ? [{ name: 'Refresh', value: 'refresh' }] : []),
      { name: 'Back', value: 'back' },
    ];

    const { next } = await inquirer.prompt<{ next: string }>([
      {
        name: 'next',
        type: 'list',
        message: 'Actions',
        choices: actions,
      },
    ]);
    if (next === 'back') {
      return;
    }
    if (next === 'refresh') {
      continue;
    }
    if (next.startsWith('log:')) {
      const [, target] = next.split(':');
      await renderSessionLog(sessionId, target === '__all__' ? undefined : target);
    }
  }
}

async function renderSessionLog(sessionId: string, model?: string): Promise<void> {
  const raw = model ? await sessionStore.readModelLog(sessionId, model) : await sessionStore.readLog(sessionId);
  const headerLabel = model ? `Log (${model})` : 'Log';
  console.log(chalk.bold(headerLabel));
  const text = trimBeforeFirstAnswer(raw);
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_RENDER_BYTES) {
    console.log(
      chalk.yellow(
        `Log is large (${size.toLocaleString()} bytes). Rendering raw text; open the log file for full context.`,
      ),
    );
    process.stdout.write(text);
    console.log('');
    return;
  }
  if (!text.trim()) {
    console.log(dim('(log is empty)'));
    console.log('');
    return;
  }
  process.stdout.write(renderMarkdownAnsi(text));
  console.log('');
}

async function getSessionLogPath(sessionId: string): Promise<string | null> {
  try {
    const paths = await sessionStore.getPaths(sessionId);
    return paths.log;
  } catch {
    return null;
  }
}

function printSessionHeader(meta: SessionMetadata): void {
  console.log(chalk.bold(`Session ${chalk.cyan(meta.id)}`));
  console.log(`${chalk.white('Status:')} ${meta.status}`);
  console.log(`${chalk.white('Created:')} ${meta.createdAt}`);
  if (meta.model) {
    console.log(`${chalk.white('Model:')} ${meta.model}`);
  }
  const mode = meta.mode ?? meta.options?.mode;
  if (mode) {
    console.log(`${chalk.white('Mode:')} ${mode}`);
  }
  if (meta.errorMessage) {
    console.log(chalk.red(`Error: ${meta.errorMessage}`));
  }
}

function printModelSummaries(models: SessionModelRun[]): void {
  if (models.length === 0) {
    return;
  }
  console.log(chalk.bold('Models:'));
  for (const run of models) {
    const usage = run.usage
      ? ` tok=${run.usage.outputTokens?.toLocaleString() ?? 0}/${run.usage.totalTokens?.toLocaleString() ?? 0}`
      : '';
    console.log(` - ${chalk.cyan(run.model)} — ${run.status}${usage}`);
  }
  console.log('');
}

interface WizardAnswers {
  promptInput: string;
  slug?: string;
  model: ModelName;
  models?: ModelName[];
  files: string[];
  chromeProfile?: string;
  chromeCookiePath?: string;
  hideWindow?: boolean;
  keepBrowser?: boolean;
  mode?: SessionMode;
}

async function askOracleFlow(version: string, userConfig: UserConfig): Promise<void> {
  const modelChoices = Object.keys(MODEL_CONFIGS) as ModelName[];
  const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
  const initialMode: SessionMode = hasApiKey ? 'api' : 'browser';
  const preferredMode: SessionMode = (userConfig.engine as SessionMode | undefined) ?? initialMode;

  const answers = await inquirer.prompt<
    WizardAnswers & { mode: SessionMode; promptInput: string }
  >([
    {
      name: 'promptInput',
      type: 'input',
      message: 'Paste your prompt text or a path to a file (leave blank to cancel):',
    },
    ...(hasApiKey
      ? [
          {
            name: 'mode',
            type: 'list',
            message: 'Engine',
            default: preferredMode,
            choices: [
              { name: 'API', value: 'api' },
              { name: 'Browser', value: 'browser' },
            ],
          } as DistinctQuestion<WizardAnswers & { mode: SessionMode }>,
        ]
      : [
          {
            name: 'mode',
            type: 'list',
            message: 'Engine',
            default: preferredMode,
            choices: [{ name: 'Browser', value: 'browser' }],
          } as DistinctQuestion<WizardAnswers & { mode: SessionMode }>,
        ]),
    {
      name: 'slug',
      type: 'input',
      message: 'Optional slug (3–5 words, leave blank for auto):',
    },
    {
      name: 'model',
      type: 'list',
      message: 'Model',
      default: DEFAULT_MODEL,
      choices: modelChoices,
    },
    {
      name: 'models',
      type: 'checkbox',
      message: 'Additional API models to fan out to (optional)',
      choices: modelChoices,
      when: (ans) => ans.mode === 'api',
      filter: (values: string[]) =>
        Array.isArray(values)
          ? values
              .map((entry) => entry.trim())
              .filter((entry): entry is ModelName => modelChoices.includes(entry as ModelName))
          : [],
    },
    {
      name: 'files',
      type: 'input',
      message: 'Files or globs to attach (comma-separated, optional):',
      filter: (value: string) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
    },
    {
      name: 'chromeProfile',
      type: 'input',
      message: 'Chrome profile to reuse cookies from:',
      default: 'Default',
      when: (ans) => ans.mode === 'browser',
    },
    {
      name: 'chromeCookiePath',
      type: 'input',
      message: 'Cookie DB path (Chromium/Edge, optional):',
      when: (ans) => ans.mode === 'browser',
    },
    {
      name: 'hideWindow',
      type: 'confirm',
      message: 'Hide Chrome window (macOS headful only)?',
      default: false,
      when: (ans) => ans.mode === 'browser',
    },
    {
      name: 'keepBrowser',
      type: 'confirm',
      message: 'Keep browser open after completion?',
      default: false,
      when: (ans) => ans.mode === 'browser',
    },
  ]);

  const mode = (answers.mode ?? initialMode) as SessionMode;
  const prompt = await resolvePromptInput(answers.promptInput);
  if (!prompt.trim()) {
    console.log(chalk.yellow('Cancelled.'));
    return;
  }
  const promptWithSuffix = userConfig.promptSuffix ? `${prompt.trim()}\n${userConfig.promptSuffix}` : prompt;
  await sessionStore.ensureStorage();
  await pruneOldSessions(userConfig.sessionRetentionHours, (message) => console.log(chalk.dim(message)));
  const normalizedMultiModels =
    Array.isArray(answers.models) && answers.models.length > 0
      ? Array.from(
          new Set(
            [answers.model, ...answers.models].filter((entry): entry is ModelName =>
              modelChoices.includes(entry as ModelName),
            ),
          ),
        )
      : [answers.model];
  const runOptions: RunOracleOptions = {
    prompt: promptWithSuffix,
    model: answers.model,
    file: answers.files,
    models: normalizedMultiModels.length > 1 ? normalizedMultiModels : undefined,
    slug: answers.slug,
    filesReport: false,
    maxInput: undefined,
    maxOutput: undefined,
    system: undefined,
    silent: false,
    search: undefined,
    preview: false,
    previewMode: undefined,
    apiKey: undefined,
    sessionId: undefined,
    verbose: false,
    heartbeatIntervalMs: undefined,
    browserInlineFiles: false,
    browserBundleFiles: false,
    background: undefined,
  };

  const browserConfig: BrowserSessionConfig | undefined =
    mode === 'browser'
      ? await buildBrowserConfig({
          browserChromeProfile: answers.chromeProfile,
          browserCookiePath: answers.chromeCookiePath,
          browserHideWindow: answers.hideWindow,
          browserKeepBrowser: answers.keepBrowser,
          browserModelLabel: resolveBrowserModelLabel(undefined, answers.model),
          model: answers.model,
        })
      : undefined;

  const notifications = resolveNotificationSettings({
    cliNotify: undefined,
    cliNotifySound: undefined,
    env: process.env,
    config: userConfig.notify,
  });

  const sessionMeta = await sessionStore.createSession(
    {
      ...runOptions,
      mode,
      browserConfig,
    },
    process.cwd(),
    notifications,
  );

  const { logLine, writeChunk, stream } = sessionStore.createLogWriter(sessionMeta.id);
  const combinedLog = (message?: string): void => {
    if (message) {
      console.log(message);
      logLine(message);
    }
  };
  // Write streamed chunks to the session log; stdout handling is owned by runOracle.
  const combinedWrite = (chunk: string): boolean => {
    writeChunk(chunk);
    return true;
  };

  console.log(chalk.bold(`Session ${sessionMeta.id} starting...`));
  console.log(dim(`Log path: ${path.join(os.homedir(), '.oracle', 'sessions', sessionMeta.id, 'output.log')}`));

  try {
    await performSessionRun({
      sessionMeta,
      runOptions: { ...runOptions, sessionId: sessionMeta.id },
      mode,
      browserConfig,
      cwd: process.cwd(),
      log: combinedLog,
      write: combinedWrite,
      version,
      notifications,
    });
    console.log(chalk.green(`Session ${sessionMeta.id} completed.`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`Session ${sessionMeta.id} failed: ${message}`));
  } finally {
    stream.end();
  }
}

const readSessionMetadataSafe = (sessionId: string): Promise<SessionMetadata | null> =>
  sessionStore.readSession(sessionId);

async function resolvePromptInput(rawInput: string): Promise<string> {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return trimmed;
  }
  const asPath = path.resolve(process.cwd(), trimmed);
  try {
    const stats = await fs.stat(asPath);
    if (stats.isFile()) {
      const contents = await fs.readFile(asPath, 'utf8');
      return contents;
    }
  } catch {
    // not a file; fall through
  }
  return trimmed;
}

async function readStoredPrompt(sessionId: string): Promise<string | null> {
  const request = await sessionStore.readRequest(sessionId);
  if (request?.prompt && request.prompt.trim().length > 0) {
    return request.prompt;
  }
  const meta = await sessionStore.readSession(sessionId);
  if (meta?.options?.prompt && meta.options.prompt.trim().length > 0) {
    return meta.options.prompt;
  }
  return null;
}

// Exported for testing
export { askOracleFlow, showSessionDetail };
export { resolveCost };
