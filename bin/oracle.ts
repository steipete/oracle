#!/usr/bin/env node
import 'dotenv/config';
import { Command, InvalidArgumentError, Option } from 'commander';
import type { OptionValues } from 'commander';
import chalk from 'chalk';
import kleur from 'kleur';
import {
  ensureSessionStorage,
  initializeSession,
  updateSessionMetadata,
  readSessionMetadata,
  listSessionsMetadata,
  filterSessionsByRange,
  createSessionLogWriter,
  readSessionLog,
  wait,
  SESSIONS_DIR,
  deleteSessionsOlderThan,
} from '../src/sessionManager.js';
import type {
  SessionMetadata,
  SessionMode,
  BrowserSessionConfig,
  BrowserRuntimeMetadata,
} from '../src/sessionManager.js';
import {
  runOracle,
  MODEL_CONFIGS,
  parseIntOption,
  renderPromptMarkdown,
  readFiles,
  buildPrompt,
  createFileSections,
  DEFAULT_SYSTEM_PROMPT,
  formatElapsed,
  TOKENIZER_OPTIONS,
} from '../src/oracle.js';
import type { ModelName, PreviewMode, RunOracleOptions } from '../src/oracle.js';
import { runBrowserMode, CHATGPT_URL, DEFAULT_MODEL_TARGET, parseDuration } from '../src/browserMode.js';

interface CliOptions extends OptionValues {
  prompt?: string;
  file?: string[];
  model: ModelName;
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
  session?: string;
  execSession?: string;
  renderMarkdown?: boolean;
  sessionId?: string;
  browser?: boolean;
  browserChromeProfile?: string;
  browserChromePath?: string;
  browserUrl?: string;
  browserTimeout?: string;
  browserInputTimeout?: string;
  browserNoCookieSync?: boolean;
  browserHeadless?: boolean;
  browserHideWindow?: boolean;
  browserKeepBrowser?: boolean;
  verbose?: boolean;
}

interface ShowStatusOptions {
  hours: number;
  includeAll: boolean;
  limit: number;
  showExamples?: boolean;
}

interface StatusOptions extends OptionValues {
  hours: number;
  limit: number;
  all: boolean;
}

const VERSION = '1.0.0';
const rawCliArgs = process.argv.slice(2);
const isTty = process.stdout.isTTY;

type Stylizer = (text: string) => string;
const colorIfTty = (styler: Stylizer): Stylizer => (text) => (isTty ? styler(text) : text);

const helpColors = {
  banner: colorIfTty((text) => kleur.bold().blue(text)),
  subtitle: colorIfTty((text) => kleur.dim(text)),
  section: colorIfTty((text) => kleur.bold().white(text)),
  bullet: colorIfTty((text) => kleur.blue(text)),
  command: colorIfTty((text) => kleur.bold().blue(text)),
  option: colorIfTty((text) => kleur.cyan(text)),
  argument: colorIfTty((text) => kleur.magenta(text)),
  description: colorIfTty((text) => kleur.white(text)),
  muted: colorIfTty((text) => kleur.gray(text)),
  accent: colorIfTty((text) => kleur.cyan(text)),
};

const program = new Command();
program.configureHelp({
  styleTitle(title) {
    return helpColors.section(title);
  },
  styleDescriptionText(text) {
    return helpColors.description(text);
  },
  styleCommandText(text) {
    return helpColors.command(text);
  },
  styleSubcommandText(text) {
    return helpColors.command(text);
  },
  styleOptionText(text) {
    return helpColors.option(text);
  },
  styleArgumentText(text) {
    return helpColors.argument(text);
  },
});
program
  .name('oracle')
  .description('One-shot GPT-5 Pro / GPT-5.1 tool for hard questions that benefit from large file context and server-side search.')
  .version(VERSION)
  .option('-p, --prompt <text>', 'User prompt to send to the model.')
  .option('-f, --file <paths...>', 'Paths to files or directories to append to the prompt; repeat, comma-separate, or supply a space-separated list.', collectPaths, [])
  .option('-s, --slug <words>', 'Custom session slug (3-5 words).')
  .option('-m, --model <model>', 'Model to target (gpt-5-pro | gpt-5.1).', validateModel, 'gpt-5-pro')
  .option('--files-report', 'Show token usage per attached file (also prints automatically when files exceed the token budget).', false)
  .option('-v, --verbose', 'Enable verbose logging for all operations.', false)
  .addOption(
    new Option('--preview [mode]', 'Preview the request without calling the API (summary | json | full).')
      .choices(['summary', 'json', 'full'])
      .preset('summary'),
  )
  .addOption(new Option('--exec-session <id>').hideHelp())
  .option('--render-markdown', 'Emit the assembled markdown bundle for prompt + files and exit.', false)
  .option('--browser', 'Run the prompt via the ChatGPT web UI (Chrome automation).', false)
  .option('--browser-chrome-profile <name>', 'Chrome profile name/path for cookie reuse.')
  .option('--browser-chrome-path <path>', 'Explicit Chrome or Chromium executable path.')
  .option('--browser-url <url>', `Override the ChatGPT URL (default ${CHATGPT_URL}).`)
  .option('--browser-timeout <ms|s|m>', 'Maximum time to wait for an answer (default 900s).')
  .option('--browser-input-timeout <ms|s|m>', 'Maximum time to wait for the prompt textarea (default 30s).')
  .option('--browser-no-cookie-sync', 'Skip copying cookies from Chrome.', false)
  .option('--browser-headless', 'Launch Chrome in headless mode.', false)
  .option('--browser-hide-window', 'Hide the Chrome window after launch (macOS headful only).', false)
  .option('--browser-keep-browser', 'Keep Chrome running after completion.', false)
  .showHelpAfterError('(use --help for usage)');

program
  .command('session [id]')
  .description('Attach to a stored session or list recent sessions when no ID is provided.')
  .option('--hours <hours>', 'Look back this many hours when listing sessions (default 24).', parseFloatOption, 24)
  .option('--limit <count>', 'Maximum sessions to show when listing (max 1000).', parseIntOption, 100)
  .option('--all', 'Include all stored sessions regardless of age.', false)
  .action(async (sessionId, cmd: Command) => {
    const sessionOptions = cmd.opts<StatusOptions>();
    if (!sessionId) {
      const showExamples = usesDefaultStatusFilters(cmd);
      await showStatus({
        hours: sessionOptions.all ? Infinity : sessionOptions.hours,
        includeAll: sessionOptions.all,
        limit: sessionOptions.limit,
        showExamples,
      });
      return;
    }
    await attachSession(sessionId);
  });

const statusCommand = program
  .command('status')
  .description('List recent sessions (24h window by default).')
  .option('--hours <hours>', 'Look back this many hours (default 24).', parseFloatOption, 24)
  .option('--limit <count>', 'Maximum sessions to show (max 1000).', parseIntOption, 100)
  .option('--all', 'Include all stored sessions regardless of age.', false)
  .action(async (_options, command: Command) => {
    const statusOptions = command.opts<StatusOptions>();
    const showExamples = usesDefaultStatusFilters(command);
    await showStatus({
      hours: statusOptions.all ? Infinity : statusOptions.hours,
      includeAll: statusOptions.all,
      limit: statusOptions.limit,
      showExamples,
    });
  });

statusCommand
  .command('clear')
  .description('Delete stored sessions older than the provided window (24h default).')
  .option('--hours <hours>', 'Delete sessions older than this many hours (default 24).', parseFloatOption, 24)
  .option('--all', 'Delete all stored sessions.', false)
  .action(async (_options, command: Command) => {
    const clearOptions = command.opts<StatusOptions>();
    const result = await deleteSessionsOlderThan({ hours: clearOptions.hours, includeAll: clearOptions.all });
    const scope = clearOptions.all ? 'all stored sessions' : `sessions older than ${clearOptions.hours}h`;
    console.log(`Deleted ${result.deleted} ${result.deleted === 1 ? 'session' : 'sessions'} (${scope}).`);
  });

const bold = (text: string): string => (isTty ? kleur.bold(text) : text);
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);

program.addHelpText('beforeAll', renderHelpBanner);
program.addHelpText('after', renderHelpFooter);

function renderHelpBanner(): string {
  const subtitle = 'GPT-5 Pro/GPT-5.1 for tough questions with code/file context.';
  return `${helpColors.banner(`Oracle CLI v${VERSION}`)} ${helpColors.subtitle(`— ${subtitle}`)}\n`;
}

function renderHelpFooter(): string {
  const tips = [
    `${helpColors.bullet('•')} Attach source files for best results, but keep total input under ~196k tokens.`,
    `${helpColors.bullet('•')} The model has no built-in knowledge of your project—open with the architecture, key components, and why you’re asking.`,
    `${helpColors.bullet('•')} Run ${helpColors.accent('--files-report')} to inspect token spend before hitting the API.`,
    `${helpColors.bullet('•')} Non-preview runs spawn detached sessions so they keep streaming even if your terminal closes.`,
    `${helpColors.bullet('•')} Ask the model for a memorable 3–5 word slug and pass it via ${helpColors.accent('--slug "<words>"')} to keep session IDs tidy.`,
  ].join('\n');

  const formatExample = (command: string, description: string): string =>
    `${helpColors.command(`  ${command}`)}\n${helpColors.muted(`    ${description}`)}`;

  const examples = [
    formatExample(
      `${program.name()} --prompt "Summarize risks" --file docs/risk.md --files-report --preview`,
      'Inspect tokens + files without calling the API.',
    ),
    formatExample(
      `${program.name()} --prompt "Explain bug" --file src/,docs/crash.log --files-report`,
      'Attach src/ plus docs/crash.log, launch a background session, and capture the Session ID.',
    ),
    formatExample(
      `${program.name()} status --hours 72 --limit 50`,
      'Show sessions from the last 72h (capped at 50 entries).',
    ),
    formatExample(
      `${program.name()} session <sessionId>`,
      'Attach to a running/completed session and stream the saved transcript.',
    ),
    formatExample(
      `${program.name()} --prompt "Ship review" --slug "release-readiness-audit"`,
      'Encourage the model to hand you a 3–5 word slug and pass it along with --slug.',
    ),
  ].join('\n\n');

  return `
${helpColors.section('Tips')}
${tips}

${helpColors.section('Examples')}
${examples}
`;
}

function collectPaths(value: string | string[] | undefined, previous: string[] = []): string[] {
  if (!value) {
    return previous;
  }
  const nextValues = Array.isArray(value) ? value : [value];
  return previous.concat(nextValues.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean));
}

function parseFloatOption(value: string): number {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError('Value must be a number.');
  }
  return parsed;
}

const DEFAULT_BROWSER_TIMEOUT_MS = 900_000;
const DEFAULT_BROWSER_INPUT_TIMEOUT_MS = 30_000;
const BROWSER_MODEL_LABELS: Record<ModelName, string> = {
  'gpt-5-pro': 'GPT-5 Pro',
  'gpt-5.1': 'ChatGPT 5.1',
};

function buildBrowserConfig(options: CliOptions): BrowserSessionConfig {
  return {
    chromeProfile: options.browserChromeProfile ?? null,
    chromePath: options.browserChromePath ?? null,
    url: options.browserUrl,
    timeoutMs: options.browserTimeout ? parseDuration(options.browserTimeout, DEFAULT_BROWSER_TIMEOUT_MS) : undefined,
    inputTimeoutMs: options.browserInputTimeout
      ? parseDuration(options.browserInputTimeout, DEFAULT_BROWSER_INPUT_TIMEOUT_MS)
      : undefined,
    cookieSync: options.browserNoCookieSync ? false : undefined,
    headless: options.browserHeadless ? true : undefined,
  keepBrowser: options.browserKeepBrowser ? true : undefined,
  hideWindow: options.browserHideWindow ? true : undefined,
  desiredModel: mapModelToBrowserLabel(options.model),
  debug: options.verbose ? true : undefined,
  };
}

function mapModelToBrowserLabel(model: ModelName): string {
  return BROWSER_MODEL_LABELS[model] ?? DEFAULT_MODEL_TARGET;
}

function validateModel(value: string): ModelName {
  if (!(value in MODEL_CONFIGS)) {
    throw new InvalidArgumentError(`Unsupported model "${value}". Choose one of: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
  }
  return value as ModelName;
}

function usesDefaultStatusFilters(cmd: Command): boolean {
  const hoursSource = cmd.getOptionValueSource?.('hours') ?? 'default';
  const limitSource = cmd.getOptionValueSource?.('limit') ?? 'default';
  const allSource = cmd.getOptionValueSource?.('all') ?? 'default';
  return hoursSource === 'default' && limitSource === 'default' && allSource === 'default';
}

function resolvePreviewMode(value: boolean | string | undefined): PreviewMode | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value as PreviewMode;
  }
  if (value === true) {
    return 'summary';
  }
  return undefined;
}

function buildRunOptions(options: CliOptions, overrides: Partial<RunOracleOptions> = {}): RunOracleOptions {
  if (!options.prompt) {
    throw new Error('Prompt is required.');
  }
  return {
    prompt: options.prompt,
    model: options.model,
    file: overrides.file ?? options.file ?? [],
    slug: overrides.slug ?? options.slug,
    filesReport: overrides.filesReport ?? options.filesReport,
    maxInput: overrides.maxInput ?? options.maxInput,
    maxOutput: overrides.maxOutput ?? options.maxOutput,
    system: overrides.system ?? options.system,
    silent: overrides.silent ?? options.silent,
    search: overrides.search ?? options.search,
    preview: overrides.preview ?? undefined,
    previewMode: overrides.previewMode ?? options.previewMode,
    apiKey: overrides.apiKey ?? options.apiKey,
    sessionId: overrides.sessionId ?? options.sessionId,
    verbose: overrides.verbose ?? options.verbose,
  };
}

function buildRunOptionsFromMetadata(metadata: SessionMetadata): RunOracleOptions {
  const stored = metadata.options ?? {};
  return {
    prompt: stored.prompt ?? '',
    model: (stored.model as ModelName) ?? 'gpt-5-pro',
    file: stored.file ?? [],
    slug: stored.slug,
    filesReport: stored.filesReport,
    maxInput: stored.maxInput,
    maxOutput: stored.maxOutput,
    system: stored.system,
    silent: stored.silent,
    search: undefined,
    preview: false,
    previewMode: undefined,
    apiKey: undefined,
    sessionId: metadata.id,
    verbose: stored.verbose,
  };
}

function getSessionMode(metadata: SessionMetadata): SessionMode {
  return metadata.mode ?? metadata.options?.mode ?? 'api';
}

function getBrowserConfigFromMetadata(metadata: SessionMetadata): BrowserSessionConfig | undefined {
  return metadata.options?.browserConfig ?? metadata.browser?.config;
}

async function runRootCommand(options: CliOptions): Promise<void> {
  const helpRequested = rawCliArgs.some((arg: string) => arg === '--help' || arg === '-h');
  if (helpRequested) {
    program.help({ error: false });
    return;
  }
  const previewMode = resolvePreviewMode(options.preview);

  if (rawCliArgs.length === 0) {
    console.log(chalk.yellow('No prompt or subcommand supplied. See `oracle --help` for usage.'));
    program.help({ error: false });
    return;
  }

  if (options.session) {
    await attachSession(options.session);
    return;
  }

  if (options.execSession) {
    await executeSession(options.execSession);
    return;
  }

  if (options.renderMarkdown) {
    if (!options.prompt) {
      throw new Error('Prompt is required when using --render-markdown.');
    }
    const markdown = await renderPromptMarkdown(
      { prompt: options.prompt, file: options.file, system: options.system },
      { cwd: process.cwd() },
    );
    console.log(markdown);
    return;
  }

  if (previewMode) {
    if (options.browser) {
      throw new Error('--browser cannot be combined with --preview.');
    }
    if (!options.prompt) {
      throw new Error('Prompt is required when using --preview.');
    }
    const runOptions = buildRunOptions(options, { preview: true, previewMode });
    await runOracle(runOptions, { log: console.log, write: (chunk: string) => process.stdout.write(chunk) });
    return;
  }

  if (!options.prompt) {
    throw new Error('Prompt is required when starting a new session.');
  }

  if (options.file && options.file.length > 0) {
    await readFiles(options.file, { cwd: process.cwd() });
  }

  const sessionMode: SessionMode = options.browser ? 'browser' : 'api';
  const browserConfig = sessionMode === 'browser' ? buildBrowserConfig(options) : undefined;

  await ensureSessionStorage();
  const baseRunOptions = buildRunOptions(options, { preview: false, previewMode: undefined });
  const sessionMeta = await initializeSession(
    {
      ...baseRunOptions,
      mode: sessionMode,
      browserConfig,
    },
    process.cwd(),
  );
  const liveRunOptions: RunOracleOptions = { ...baseRunOptions, sessionId: sessionMeta.id };
  await runInteractiveSession(sessionMeta, liveRunOptions, sessionMode, browserConfig);
  console.log(chalk.bold(`Session ${sessionMeta.id} completed`));
}

async function runInteractiveSession(
  sessionMeta: SessionMetadata,
  runOptions: RunOracleOptions,
  mode: SessionMode,
  browserConfig?: BrowserSessionConfig,
): Promise<void> {
  const { logLine, writeChunk, stream } = createSessionLogWriter(sessionMeta.id);
  let headerAugmented = false;
  const combinedLog = (message = ''): void => {
    if (!headerAugmented && message.startsWith('Oracle (')) {
      headerAugmented = true;
      console.log(`${message}\n${chalk.blue(`Reattach via: oracle session ${sessionMeta.id}`)}`);
      logLine(message);
      return;
    }
    console.log(message);
    logLine(message);
  };
  const combinedWrite = (chunk: string): boolean => {
    writeChunk(chunk);
    return process.stdout.write(chunk);
  };
  try {
    await performSessionRun({
      sessionMeta,
      runOptions,
      mode,
      browserConfig,
      cwd: process.cwd(),
      log: combinedLog,
      write: combinedWrite,
    });
  } catch (error) {
    throw error;
  } finally {
    stream.end();
  }
}

async function executeSession(sessionId: string) {
  const metadata = await readSessionMetadata(sessionId);
  if (!metadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  const runOptions = buildRunOptionsFromMetadata(metadata);
  const sessionMode = getSessionMode(metadata);
  const browserConfig = getBrowserConfigFromMetadata(metadata);
  const { logLine, writeChunk, stream } = createSessionLogWriter(sessionId);
  try {
    await performSessionRun({
      sessionMeta: metadata,
      runOptions,
      mode: sessionMode,
      browserConfig,
      cwd: metadata.cwd ?? process.cwd(),
      log: logLine,
      write: writeChunk,
    });
  } catch {
    // Errors are already logged to the session log; keep quiet to mirror stored-session behavior.
  } finally {
    stream.end();
  }
}

interface SessionRunParams {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  mode: SessionMode;
  browserConfig?: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
  write: (chunk: string) => boolean;
}

interface BrowserExecutionResult {
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  elapsedMs: number;
  runtime: BrowserRuntimeMetadata;
}

interface BrowserPromptArtifacts {
  markdown: string;
  estimatedInputTokens: number;
}

async function performSessionRun({
  sessionMeta,
  runOptions,
  mode,
  browserConfig,
  cwd,
  log,
  write,
}: SessionRunParams): Promise<void> {
  await updateSessionMetadata(sessionMeta.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    mode,
    ...(browserConfig ? { browser: { config: browserConfig } } : {}),
  });
  try {
    if (mode === 'browser') {
      if (!browserConfig) {
        throw new Error('Missing browser configuration for session.');
      }
      const result = await runBrowserSessionExecution({
        runOptions,
        browserConfig,
        cwd,
        log,
      });
      await updateSessionMetadata(sessionMeta.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        browser: {
          config: browserConfig,
          runtime: result.runtime,
        },
      });
      return;
    }
    const result = await runOracle(runOptions, {
      cwd,
      log,
      write,
    });
    if (result.mode !== 'live') {
      throw new Error('Unexpected preview result while running a session.');
    }
    await updateSessionMetadata(sessionMeta.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      usage: result.usage,
      elapsedMs: result.elapsedMs,
    });
  } catch (error: unknown) {
    const message = formatError(error);
    log(`ERROR: ${message}`);
    await updateSessionMetadata(sessionMeta.id, {
      status: 'error',
      completedAt: new Date().toISOString(),
      errorMessage: message,
      mode,
      browser: browserConfig ? { config: browserConfig } : undefined,
    });
    throw error;
  }
}

async function runBrowserSessionExecution({
  runOptions,
  browserConfig,
  cwd,
  log,
}: {
  runOptions: RunOracleOptions;
  browserConfig: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
}): Promise<BrowserExecutionResult> {
  const promptArtifacts = await assembleBrowserPrompt(runOptions, cwd);
  if (runOptions.verbose) {
    log(
      dim(
        `[verbose] Browser config: ${JSON.stringify({
          ...browserConfig,
        })}`,
      ),
    );
    log(dim(`[verbose] Browser prompt length: ${promptArtifacts.markdown.length} chars`));
  }
  const headerLine = `Oracle (${VERSION}) launching browser mode (${runOptions.model}) with ~${promptArtifacts.estimatedInputTokens.toLocaleString()} tokens`;
  log(headerLine);
  log(dim('Chrome automation does not stream output; this may take a minute...'));
  const browserResult = await runBrowserMode({
    prompt: promptArtifacts.markdown,
    config: browserConfig,
    log,
  });
  if (!runOptions.silent) {
    log(chalk.bold('Answer:'));
    log(browserResult.answerMarkdown || browserResult.answerText || chalk.dim('(no text output)'));
    log('');
  }
  const usage = {
    inputTokens: promptArtifacts.estimatedInputTokens,
    outputTokens: browserResult.answerTokens,
    reasoningTokens: 0,
    totalTokens: promptArtifacts.estimatedInputTokens + browserResult.answerTokens,
  };
  const tokensDisplay = `${usage.inputTokens}/${usage.outputTokens}/${usage.reasoningTokens}/${usage.totalTokens}`;
  const statsParts = [`${runOptions.model}[browser]`, `tok(i/o/r/t)=${tokensDisplay}`];
  if (runOptions.file && runOptions.file.length > 0) {
    statsParts.push(`files=${runOptions.file.length}`);
  }
  log(chalk.blue(`Finished in ${formatElapsed(browserResult.tookMs)} (${statsParts.join(' | ')})`));
  return {
    usage,
    elapsedMs: browserResult.tookMs,
    runtime: {
      chromePid: browserResult.chromePid,
      chromePort: browserResult.chromePort,
      userDataDir: browserResult.userDataDir,
    },
  };
}

async function assembleBrowserPrompt(runOptions: RunOracleOptions, cwd: string): Promise<BrowserPromptArtifacts> {
  const files = await readFiles(runOptions.file ?? [], { cwd });
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

async function showStatus({ hours, includeAll, limit, showExamples = false }: ShowStatusOptions) {
  const metas = await listSessionsMetadata();
  const { entries, truncated, total } = filterSessionsByRange(metas, { hours, includeAll, limit });
  if (!entries.length) {
    console.log('No sessions found for the requested range.');
    if (showExamples) {
      printStatusExamples();
    }
    return;
  }
  console.log(chalk.bold('Recent Sessions'));
  for (const entry of entries) {
    const status = (entry.status || 'unknown').padEnd(9);
    const model = (entry.model || 'n/a').padEnd(10);
    const created = entry.createdAt.replace('T', ' ').replace('Z', '');
    console.log(`${created} | ${status} | ${model} | ${entry.id}`);
  }
  if (truncated) {
    console.log(
      chalk.yellow(
        `Showing ${entries.length} of ${total} sessions from the requested range. Run "oracle status clear" or delete entries in ${SESSIONS_DIR} to free space, or rerun with --status-limit/--status-all.`,
      ),
    );
  }
  if (showExamples) {
    printStatusExamples();
  }
}

function printStatusExamples(): void {
  console.log('');
  console.log(chalk.bold('Usage Examples'));
  console.log(`${chalk.bold('  oracle status --hours 72 --limit 50')}`);
  console.log(dim('    Show 72h of history capped at 50 entries.'));
  console.log(`${chalk.bold('  oracle status clear --hours 168')}`);
  console.log(dim('    Delete sessions older than 7 days (use --all to wipe everything).'));
  console.log(`${chalk.bold('  oracle session <session-id>')}`);
  console.log(dim('    Attach to a specific running/completed session to stream its output.'));
}

async function attachSession(sessionId: string): Promise<void> {
  const metadata = await readSessionMetadata(sessionId);
  if (!metadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  const reattachLine = buildReattachLine(metadata);
  if (reattachLine) {
    console.log(chalk.blue(reattachLine));
  } else {
    console.log(chalk.bold(`Session ${sessionId}`));
  }
  console.log(`Created: ${metadata.createdAt}`);
  console.log(`Status: ${metadata.status}`);
  console.log(`Model: ${metadata.model}`);

  let lastLength = 0;
  const printNew = async () => {
    const text = await readSessionLog(sessionId);
    const nextChunk = text.slice(lastLength);
    if (nextChunk.length > 0) {
      process.stdout.write(nextChunk);
      lastLength = text.length;
    }
  };

  await printNew();

  // biome-ignore lint/nursery/noUnnecessaryConditions: deliberate infinite poll
  while (true) {
    const latest = await readSessionMetadata(sessionId);
    if (!latest) {
      break;
    }
    if (latest.status === 'completed' || latest.status === 'error') {
      await printNew();
      if (latest.status === 'error' && latest.errorMessage) {
        console.log(`\nSession failed: ${latest.errorMessage}`);
      }
      if (latest.usage) {
        const usage = latest.usage;
        console.log(`\nFinished (tok i/o/r/t: ${usage.inputTokens}/${usage.outputTokens}/${usage.reasoningTokens}/${usage.totalTokens})`);
      }
      break;
    }
    await wait(1000);
    await printNew();
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildReattachLine(metadata: SessionMetadata): string | null {
  if (!metadata.id) {
    return null;
  }
  const referenceTime = metadata.startedAt ?? metadata.createdAt;
  if (!referenceTime) {
    return null;
  }
  const elapsedLabel = formatRelativeDuration(referenceTime);
  if (!elapsedLabel) {
    return null;
  }
  if (metadata.status === 'running') {
    return `Session ${metadata.id} reattached, request started ${elapsedLabel} ago.`;
  }
  return null;
}

function formatRelativeDuration(referenceIso: string): string | null {
  const timestamp = Date.parse(referenceIso);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) {
    return null;
  }
  const seconds = Math.max(1, Math.round(diffMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    const parts = [`${hours}h`];
    if (remainingMinutes > 0) {
      parts.push(`${remainingMinutes}m`);
    }
    return parts.join(' ');
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const parts = [`${days}d`];
  if (remainingHours > 0) {
    parts.push(`${remainingHours}h`);
  }
  if (remainingMinutes > 0 && days === 0) {
    parts.push(`${remainingMinutes}m`);
  }
  return parts.join(' ');
}

program.action(async function (this: Command) {
  const options = this.optsWithGlobals() as CliOptions;
  await runRootCommand(options);
});

await program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(chalk.red('✖'), error.message);
  } else {
    console.error(chalk.red('✖'), error);
  }
  process.exitCode = 1;
});
