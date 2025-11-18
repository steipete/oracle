#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import type { OptionValues } from 'commander';
import { resolveEngine, type EngineMode, defaultWaitPreference } from '../src/cli/engine.js';
import { shouldRequirePrompt } from '../src/cli/promptRequirement.js';
import chalk from 'chalk';
import {
  ensureSessionStorage,
  initializeSession,
  readSessionMetadata,
  createSessionLogWriter,
  deleteSessionsOlderThan,
} from '../src/sessionManager.js';
import type { SessionMetadata, SessionMode, BrowserSessionConfig } from '../src/sessionManager.js';
import { runOracle, renderPromptMarkdown, readFiles } from '../src/oracle.js';
import type { ModelName, PreviewMode, RunOracleOptions } from '../src/oracle.js';
import { CHATGPT_URL } from '../src/browserMode.js';
import { applyHelpStyling } from '../src/cli/help.js';
import {
  collectPaths,
  parseFloatOption,
  parseIntOption,
  parseSearchOption,
  usesDefaultStatusFilters,
  resolvePreviewMode,
  normalizeModelOption,
  normalizeBaseUrl,
  resolveApiModel,
  inferModelFromLabel,
  parseHeartbeatOption,
} from '../src/cli/options.js';
import { applyHiddenAliases } from '../src/cli/hiddenAliases.js';
import { buildBrowserConfig, resolveBrowserModelLabel } from '../src/cli/browserConfig.js';
import { performSessionRun } from '../src/cli/sessionRunner.js';
import { attachSession, showStatus, formatCompletionSummary } from '../src/cli/sessionDisplay.js';
import type { ShowStatusOptions } from '../src/cli/sessionDisplay.js';
import { handleSessionCommand, type StatusOptions, formatSessionCleanupMessage } from '../src/cli/sessionCommand.js';
import { isErrorLogged } from '../src/cli/errorUtils.js';
import { handleSessionAlias, handleStatusFlag } from '../src/cli/rootAlias.js';
import { getCliVersion } from '../src/version.js';
import { runDryRunSummary, runBrowserPreview } from '../src/cli/dryRun.js';
import { launchTui } from '../src/cli/tui/index.js';
import {
  resolveNotificationSettings,
  deriveNotificationSettingsFromMetadata,
  type NotificationSettings,
} from '../src/cli/notifier.js';
import { loadUserConfig, type UserConfig } from '../src/config.js';

interface CliOptions extends OptionValues {
  prompt?: string;
  message?: string;
  file?: string[];
  include?: string[];
  model: string;
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
  notify?: boolean;
  notifySound?: boolean;
  renderMarkdown?: boolean;
  sessionId?: string;
  engine?: EngineMode;
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
  browserAllowCookieErrors?: boolean;
  browserInlineFiles?: boolean;
  browserBundleFiles?: boolean;
  verbose?: boolean;
  debugHelp?: boolean;
  heartbeat?: number;
  status?: boolean;
  dryRun?: boolean;
  wait?: boolean;
  noWait?: boolean;
  baseUrl?: string;
}

type ResolvedCliOptions = Omit<CliOptions, 'model'> & { model: ModelName };

const VERSION = getCliVersion();
const CLI_ENTRYPOINT = fileURLToPath(import.meta.url);
const rawCliArgs = process.argv.slice(2);
const userCliArgs = rawCliArgs[0] === CLI_ENTRYPOINT ? rawCliArgs.slice(1) : rawCliArgs;
const isTty = process.stdout.isTTY;
const tuiEnabled = () => isTty && process.env.ORACLE_NO_TUI !== '1';

const program = new Command();
applyHelpStyling(program, VERSION, isTty);
program.hook('preAction', (thisCommand) => {
  if (thisCommand !== program) {
    return;
  }
  if (userCliArgs.some((arg) => arg === '--help' || arg === '-h')) {
    return;
  }
  if (userCliArgs.length === 0 && tuiEnabled()) {
    // Skip prompt enforcement; runRootCommand will launch the TUI.
    return;
  }
  const opts = thisCommand.optsWithGlobals() as CliOptions;
  applyHiddenAliases(opts, (key, value) => thisCommand.setOptionValue(key, value));
  const positional = thisCommand.args?.[0] as string | undefined;
  if (!opts.prompt && positional) {
    opts.prompt = positional;
    thisCommand.setOptionValue('prompt', positional);
  }
  if (shouldRequirePrompt(userCliArgs, opts)) {
    console.log(chalk.yellow('Prompt is required. Provide it via --prompt "<text>" or positional [prompt].'));
    thisCommand.help({ error: false });
    process.exitCode = 1;
    return;
  }
});
program
  .name('oracle')
  .description('One-shot GPT-5 Pro / GPT-5.1 tool for hard questions that benefit from large file context and server-side search.')
  .version(VERSION)
  .argument('[prompt]', 'Prompt text (shorthand for --prompt).')
  .option('-p, --prompt <text>', 'User prompt to send to the model.')
  .addOption(new Option('--message <text>', 'Alias for --prompt.').hideHelp())
  .option(
    '-f, --file <paths...>',
    'Files/directories or glob patterns to attach (prefix with !pattern to exclude). Files larger than 1 MB are rejected automatically.',
    collectPaths,
    [],
  )
  .addOption(
    new Option('--include <paths...>', 'Alias for --file.')
      .argParser(collectPaths)
      .default([])
      .hideHelp(),
  )
  .option('-s, --slug <words>', 'Custom session slug (3-5 words).')
  .option(
    '-m, --model <model>',
    'Model to target (gpt-5-pro | gpt-5.1, or ChatGPT labels like "5.1 Instant" for browser runs).',
    normalizeModelOption,
    'gpt-5-pro',
  )
  .addOption(
    new Option(
      '-e, --engine <mode>',
      'Execution engine (api | browser). If omitted, oracle picks api when OPENAI_API_KEY is set, otherwise browser.',
    ).choices(['api', 'browser'])
  )
  .option('--files-report', 'Show token usage per attached file (also prints automatically when files exceed the token budget).', false)
  .option('-v, --verbose', 'Enable verbose logging for all operations.', false)
  .addOption(
    new Option('--[no-]notify', 'Desktop notification when a session finishes (default on unless CI/SSH).')
      .default(undefined),
  )
  .addOption(
    new Option('--[no-]notify-sound', 'Play a notification sound on completion (default off).').default(undefined),
  )
  .option('--dry-run', 'Validate inputs and show token estimates without calling the model.', false)
  .addOption(
    new Option('--preview [mode]', 'Preview the request without calling the API (summary | json | full).')
      .choices(['summary', 'json', 'full'])
      .preset('summary'),
  )
  .addOption(new Option('--exec-session <id>').hideHelp())
  .addOption(new Option('--session <id>').hideHelp())
  .addOption(new Option('--status', 'Show stored sessions (alias for `oracle status`).').default(false).hideHelp())
  .option('--render-markdown', 'Emit the assembled markdown bundle for prompt + files and exit.', false)
  .option('--verbose-render', 'Show render/TTY diagnostics when replaying sessions.', false)
  .addOption(
    new Option('--search <mode>', 'Set server-side search behavior (on/off).')
      .argParser(parseSearchOption)
      .hideHelp(),
  )
  .addOption(
    new Option('--max-input <tokens>', 'Override the input token budget for the selected model.')
      .argParser(parseIntOption)
      .hideHelp(),
  )
  .addOption(
    new Option('--max-output <tokens>', 'Override the max output tokens for the selected model.')
      .argParser(parseIntOption)
      .hideHelp(),
  )
  .option(
    '--base-url <url>',
    'Override the OpenAI-compatible base URL for API runs (e.g. LiteLLM proxy endpoint).',
  )
  .addOption(new Option('--browser', '(deprecated) Use --engine browser instead.').default(false).hideHelp())
  .addOption(new Option('--browser-chrome-profile <name>', 'Chrome profile name/path for cookie reuse.').hideHelp())
  .addOption(new Option('--browser-chrome-path <path>', 'Explicit Chrome or Chromium executable path.').hideHelp())
  .addOption(new Option('--browser-url <url>', `Override the ChatGPT URL (default ${CHATGPT_URL}).`).hideHelp())
  .addOption(new Option('--browser-timeout <ms|s|m>', 'Maximum time to wait for an answer (default 900s).').hideHelp())
  .addOption(
    new Option('--browser-input-timeout <ms|s|m>', 'Maximum time to wait for the prompt textarea (default 30s).').hideHelp(),
  )
  .addOption(new Option('--browser-no-cookie-sync', 'Skip copying cookies from Chrome.').hideHelp())
  .addOption(new Option('--browser-headless', 'Launch Chrome in headless mode.').hideHelp())
  .addOption(new Option('--browser-hide-window', 'Hide the Chrome window after launch (macOS headful only).').hideHelp())
  .addOption(new Option('--browser-keep-browser', 'Keep Chrome running after completion.').hideHelp())
  .addOption(
    new Option('--browser-allow-cookie-errors', 'Continue even if Chrome cookies cannot be copied.').hideHelp(),
  )
  .addOption(
    new Option('--browser-inline-files', 'Paste files directly into the ChatGPT composer instead of uploading attachments.').default(false),
  )
  .addOption(new Option('--browser-bundle-files', 'Bundle all attachments into a single archive before uploading.').default(false))
  .option('--debug-help', 'Show the advanced/debug option set and exit.', false)
  .option('--heartbeat <seconds>', 'Emit periodic in-progress updates (0 to disable).', parseHeartbeatOption, 30)
  .addOption(new Option('--wait').default(undefined))
  .addOption(new Option('--no-wait').default(undefined).hideHelp())
  .showHelpAfterError('(use --help for usage)');

program.addHelpText(
  'after',
  `
Examples:
  # Quick API run with two files
  oracle --prompt "Summarize the risk register" --file docs/risk-register.md docs/risk-matrix.md

  # Browser run (no API key) + globbed TypeScript sources, excluding tests
  oracle --engine browser --prompt "Review the TS data layer" \\
    --file "src/**/*.ts" --file "!src/**/*.test.ts"
`,
);

const sessionCommand = program
  .command('session [id]')
  .description('Attach to a stored session or list recent sessions when no ID is provided.')
  .option('--hours <hours>', 'Look back this many hours when listing sessions (default 24).', parseFloatOption, 24)
  .option('--limit <count>', 'Maximum sessions to show when listing (max 1000).', parseIntOption, 100)
  .option('--all', 'Include all stored sessions regardless of age.', false)
  .option('--clear', 'Delete stored sessions older than the provided window (24h default).', false)
  .option('--hide-prompt', 'Hide stored prompt when displaying a session.', false)
  .option('--render', 'Render completed session output as markdown (rich TTY only).', false)
  .option('--render-markdown', 'Alias for --render.', false)
  .option('--path', 'Print the stored session paths instead of attaching.', false)
  .addOption(new Option('--clean', 'Deprecated alias for --clear.').default(false).hideHelp())
  .action(async (sessionId, _options: StatusOptions, cmd: Command) => {
    await handleSessionCommand(sessionId, cmd);
  });

const statusCommand = program
  .command('status [id]')
  .description('List recent sessions (24h window by default) or attach to a session when an ID is provided.')
  .option('--hours <hours>', 'Look back this many hours (default 24).', parseFloatOption, 24)
  .option('--limit <count>', 'Maximum sessions to show (max 1000).', parseIntOption, 100)
  .option('--all', 'Include all stored sessions regardless of age.', false)
  .option('--clear', 'Delete stored sessions older than the provided window (24h default).', false)
  .option('--render', 'Render completed session output as markdown (rich TTY only).', false)
  .option('--render-markdown', 'Alias for --render.', false)
  .option('--hide-prompt', 'Hide stored prompt when displaying a session.', false)
  .addOption(new Option('--clean', 'Deprecated alias for --clear.').default(false).hideHelp())
  .action(async (sessionId: string | undefined, _options: StatusOptions, command: Command) => {
    const statusOptions = command.opts<StatusOptions>();
    const clearRequested = Boolean(statusOptions.clear || statusOptions.clean);
    if (clearRequested) {
      if (sessionId) {
        console.error('Cannot combine a session ID with --clear. Remove the ID to delete cached sessions.');
        process.exitCode = 1;
        return;
      }
      const hours = statusOptions.hours;
      const includeAll = statusOptions.all;
      const result = await deleteSessionsOlderThan({ hours, includeAll });
      const scope = includeAll ? 'all stored sessions' : `sessions older than ${hours}h`;
      console.log(formatSessionCleanupMessage(result, scope));
      return;
    }
    if (sessionId === 'clear' || sessionId === 'clean') {
      console.error('Session cleanup now uses --clear. Run "oracle status --clear --hours <n>" instead.');
      process.exitCode = 1;
      return;
    }
    if (sessionId) {
      const autoRender = !command.getOptionValueSource?.('render') && !command.getOptionValueSource?.('renderMarkdown')
        ? process.stdout.isTTY
        : false;
      const renderMarkdown = Boolean(statusOptions.render || statusOptions.renderMarkdown || autoRender);
      await attachSession(sessionId, { renderMarkdown, renderPrompt: !statusOptions.hidePrompt });
      return;
    }
    const showExamples = usesDefaultStatusFilters(command);
    await showStatus({
      hours: statusOptions.all ? Infinity : statusOptions.hours,
      includeAll: statusOptions.all,
      limit: statusOptions.limit,
      showExamples,
    });
  });

function buildRunOptions(options: ResolvedCliOptions, overrides: Partial<RunOracleOptions> = {}): RunOracleOptions {
  if (!options.prompt) {
    throw new Error('Prompt is required.');
  }
  const normalizedBaseUrl = normalizeBaseUrl(overrides.baseUrl ?? options.baseUrl);
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
    baseUrl: normalizedBaseUrl,
    sessionId: overrides.sessionId ?? options.sessionId,
    verbose: overrides.verbose ?? options.verbose,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? resolveHeartbeatIntervalMs(options.heartbeat),
    browserInlineFiles: overrides.browserInlineFiles ?? options.browserInlineFiles ?? false,
    browserBundleFiles: overrides.browserBundleFiles ?? options.browserBundleFiles ?? false,
    background: overrides.background ?? undefined,
  };
}

export function enforceBrowserSearchFlag(
  runOptions: RunOracleOptions,
  sessionMode: SessionMode,
  logFn: (message: string) => void = console.log,
): void {
  if (sessionMode === 'browser' && runOptions.search === false) {
    logFn(chalk.dim('Note: search is not available in browser engine; ignoring search=false.'));
    runOptions.search = undefined;
  }
}

function resolveHeartbeatIntervalMs(seconds: number | undefined): number | undefined {
  if (typeof seconds !== 'number' || seconds <= 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
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
    search: stored.search,
    preview: false,
    previewMode: undefined,
    apiKey: undefined,
    baseUrl: normalizeBaseUrl(stored.baseUrl),
    sessionId: metadata.id,
    verbose: stored.verbose,
    heartbeatIntervalMs: stored.heartbeatIntervalMs,
    browserInlineFiles: stored.browserInlineFiles,
    browserBundleFiles: stored.browserBundleFiles,
    background: stored.background,
  };
}

function getSessionMode(metadata: SessionMetadata): SessionMode {
  return metadata.mode ?? metadata.options?.mode ?? 'api';
}

function getBrowserConfigFromMetadata(metadata: SessionMetadata): BrowserSessionConfig | undefined {
  return metadata.options?.browserConfig ?? metadata.browser?.config;
}

async function runRootCommand(options: CliOptions): Promise<void> {
  const userConfig = (await loadUserConfig()).config;
  const helpRequested = rawCliArgs.some((arg: string) => arg === '--help' || arg === '-h');
  const optionUsesDefault = (name: string): boolean => {
    // Commander reports undefined for untouched options, so treat undefined/default the same
    const source = program.getOptionValueSource?.(name);
    return source == null || source === 'default';
  };
  if (helpRequested) {
    if (options.verbose) {
      console.log('');
      printDebugHelp(program.name());
      console.log('');
    }
    program.help({ error: false });
    return;
  }
  const previewMode = resolvePreviewMode(options.preview);

  if (userCliArgs.length === 0) {
    if (tuiEnabled()) {
      await launchTui({ version: VERSION });
      return;
    }
    console.log(chalk.yellow('No prompt or subcommand supplied. See `oracle --help` for usage.'));
    program.help({ error: false });
    return;
  }

  if (options.debugHelp) {
    printDebugHelp(program.name());
    return;
  }
  if (options.dryRun && previewMode) {
    throw new Error('--dry-run cannot be combined with --preview.');
  }
  if (options.dryRun && options.renderMarkdown) {
    throw new Error('--dry-run cannot be combined with --render-markdown.');
  }

  const preferredEngine = options.engine ?? userConfig.engine;
  const engine: EngineMode = resolveEngine({ engine: preferredEngine, browserFlag: options.browser, env: process.env });
  if (options.browser) {
    console.log(chalk.yellow('`--browser` is deprecated; use `--engine browser` instead.'));
  }
  if (optionUsesDefault('model') && userConfig.model) {
    options.model = userConfig.model;
  }
  if (optionUsesDefault('search') && userConfig.search) {
    options.search = userConfig.search === 'on';
  }
  if (optionUsesDefault('filesReport') && userConfig.filesReport != null) {
    options.filesReport = Boolean(userConfig.filesReport);
  }
  if (optionUsesDefault('heartbeat') && typeof userConfig.heartbeatSeconds === 'number') {
    options.heartbeat = userConfig.heartbeatSeconds;
  }
  if (optionUsesDefault('baseUrl') && userConfig.apiBaseUrl) {
    options.baseUrl = userConfig.apiBaseUrl;
  }
  const cliModelArg = normalizeModelOption(options.model) || 'gpt-5-pro';
  const resolvedModel: ModelName = engine === 'browser' ? inferModelFromLabel(cliModelArg) : resolveApiModel(cliModelArg);
  const resolvedBaseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.OPENAI_BASE_URL);
  const resolvedOptions: ResolvedCliOptions = { ...options, model: resolvedModel };
  resolvedOptions.baseUrl = resolvedBaseUrl;

  // Decide whether to block until completion:
  // - explicit --wait / --no-wait wins
  // - otherwise block for fast models (gpt-5.1, browser) and detach by default for gpt-5-pro API
  const waitPreference = resolveWaitFlag({
    waitFlag: options.wait,
    noWaitFlag: options.noWait,
    model: resolvedModel,
    engine,
  });

  if (await handleStatusFlag(options, { attachSession, showStatus })) {
    return;
  }

  if (await handleSessionAlias(options, { attachSession })) {
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
    if (!options.prompt) {
      throw new Error('Prompt is required when using --preview.');
    }
    if (userConfig.promptSuffix) {
      options.prompt = `${options.prompt.trim()}\n${userConfig.promptSuffix}`;
    }
    resolvedOptions.prompt = options.prompt;
    const runOptions = buildRunOptions(resolvedOptions, { preview: true, previewMode, baseUrl: resolvedBaseUrl });
    if (engine === 'browser') {
      await runBrowserPreview(
        {
          runOptions,
          cwd: process.cwd(),
          version: VERSION,
          previewMode,
          log: console.log,
        },
        {},
      );
      return;
    }
    await runOracle(runOptions, { log: console.log, write: (chunk: string) => process.stdout.write(chunk) });
    return;
  }

  if (!options.prompt) {
    throw new Error('Prompt is required when starting a new session.');
  }

  if (userConfig.promptSuffix) {
    options.prompt = `${options.prompt.trim()}\n${userConfig.promptSuffix}`;
  }
  resolvedOptions.prompt = options.prompt;

  if (options.dryRun) {
    const baseRunOptions = buildRunOptions(resolvedOptions, {
      preview: false,
      previewMode: undefined,
      baseUrl: resolvedBaseUrl,
    });
    await runDryRunSummary(
      {
        engine,
        runOptions: baseRunOptions,
        cwd: process.cwd(),
        version: VERSION,
        log: console.log,
      },
      {},
    );
    return;
  }

  if (options.file && options.file.length > 0) {
    await readFiles(options.file, { cwd: process.cwd() });
  }

  applyBrowserDefaultsFromConfig(options, userConfig);

  const notifications = resolveNotificationSettings({
    cliNotify: options.notify,
    cliNotifySound: options.notifySound,
    env: process.env,
    config: userConfig.notify,
  });

  const sessionMode: SessionMode = engine === 'browser' ? 'browser' : 'api';
  const browserModelLabelOverride =
    sessionMode === 'browser' ? resolveBrowserModelLabel(cliModelArg, resolvedModel) : undefined;
  const browserConfig =
    sessionMode === 'browser'
      ? buildBrowserConfig({
          ...options,
          model: resolvedModel,
          browserModelLabel: browserModelLabelOverride,
        })
      : undefined;

  await ensureSessionStorage();
  const baseRunOptions = buildRunOptions(resolvedOptions, {
    preview: false,
    previewMode: undefined,
    background: userConfig.background ?? resolvedOptions.background,
    baseUrl: resolvedBaseUrl,
  });
  enforceBrowserSearchFlag(baseRunOptions, sessionMode, console.log);
  if (sessionMode === 'browser' && baseRunOptions.search === false) {
    console.log(chalk.dim('Note: search is not available in browser engine; ignoring search=false.'));
    baseRunOptions.search = undefined;
  }
  const sessionMeta = await initializeSession(
    {
      ...baseRunOptions,
      mode: sessionMode,
      browserConfig,
    },
    process.cwd(),
    notifications,
  );
  const reattachCommand = `pnpm oracle session ${sessionMeta.id}`;
  console.log(chalk.bold(`Reattach later with: ${chalk.cyan(reattachCommand)}`));
  console.log('');
  const liveRunOptions: RunOracleOptions = { ...baseRunOptions, sessionId: sessionMeta.id };
  const disableDetach = process.env.ORACLE_NO_DETACH === '1';
  const detached = disableDetach
    ? false
    : await launchDetachedSession(sessionMeta.id).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.yellow(`Unable to detach session runner (${message}). Running inline...`));
      return false;
    });

  if (!waitPreference) {
    if (!detached) {
      console.log(chalk.red('Unable to start in background; use --wait to run inline.'));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.blue(`Session running in background. Reattach via: oracle session ${sessionMeta.id}`));
    console.log(chalk.dim('Pro runs can take up to 10 minutes. Add --wait to stay attached.'));
    return;
  }

  if (detached === false) {
    await runInteractiveSession(sessionMeta, liveRunOptions, sessionMode, browserConfig, true, notifications, userConfig);
    console.log(chalk.bold(`Session ${sessionMeta.id} completed`));
    return;
  }
  if (detached) {
    console.log(chalk.blue(`Reattach via: oracle session ${sessionMeta.id}`));
    await attachSession(sessionMeta.id, { suppressMetadata: true });
    console.log(chalk.bold(`Session ${sessionMeta.id} completed`));
  }
}

async function runInteractiveSession(
  sessionMeta: SessionMetadata,
  runOptions: RunOracleOptions,
  mode: SessionMode,
  browserConfig?: BrowserSessionConfig,
  showReattachHint = true,
  notifications?: NotificationSettings,
  userConfig?: UserConfig,
): Promise<void> {
  const { logLine, writeChunk, stream } = createSessionLogWriter(sessionMeta.id);
  let headerAugmented = false;
  const combinedLog = (message = ''): void => {
    if (!headerAugmented && message.startsWith('oracle (')) {
      headerAugmented = true;
      if (showReattachHint) {
        console.log(`${message}\n${chalk.blue(`Reattach via: oracle session ${sessionMeta.id}`)}`);
      } else {
        console.log(message);
      }
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
      version: VERSION,
      notifications:
        notifications ?? deriveNotificationSettingsFromMetadata(sessionMeta, process.env, userConfig?.notify),
    });
    const latest = await readSessionMetadata(sessionMeta.id);
    const summary = latest ? formatCompletionSummary(latest, { includeSlug: true }) : null;
    if (summary) {
      console.log('\n' + chalk.green.bold(summary));
      logLine(summary); // plain text in log, colored on stdout
    }
  } catch (error) {
    throw error;
  } finally {
    stream.end();
  }
}

async function launchDetachedSession(sessionId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    try {
      const args = ['--', CLI_ENTRYPOINT, '--exec-session', sessionId];
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch (error) {
      reject(error);
    }
  });
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
  const userConfig = (await loadUserConfig()).config;
  const notifications = deriveNotificationSettingsFromMetadata(metadata, process.env, userConfig.notify);
  try {
    await performSessionRun({
      sessionMeta: metadata,
      runOptions,
      mode: sessionMode,
      browserConfig,
      cwd: metadata.cwd ?? process.cwd(),
      log: logLine,
      write: writeChunk,
      version: VERSION,
      notifications,
    });
  } catch {
    // Errors are already logged to the session log; keep quiet to mirror stored-session behavior.
  } finally {
    stream.end();
  }
}

function printDebugHelp(cliName: string): void {
  console.log(chalk.bold('Advanced Options'));
  printDebugOptionGroup([
    ['--search <on|off>', 'Enable or disable the server-side search tool (default on).'],
    ['--max-input <tokens>', 'Override the input token budget.'],
    ['--max-output <tokens>', 'Override the max output tokens (model default otherwise).'],
  ]);
  console.log('');
  console.log(chalk.bold('Browser Options'));
  printDebugOptionGroup([
    ['--browser-chrome-profile <name>', 'Reuse cookies from a specific Chrome profile.'],
    ['--browser-chrome-path <path>', 'Point to a custom Chrome/Chromium binary.'],
    ['--browser-url <url>', 'Hit an alternate ChatGPT host.'],
    ['--browser-timeout <ms|s|m>', 'Cap total wait time for the assistant response.'],
    ['--browser-input-timeout <ms|s|m>', 'Cap how long we wait for the composer textarea.'],
    ['--browser-no-cookie-sync', 'Skip copying cookies from your main profile.'],
    ['--browser-headless', 'Launch Chrome in headless mode.'],
    ['--browser-hide-window', 'Hide the Chrome window (macOS headful only).'],
    ['--browser-keep-browser', 'Leave Chrome running after completion.'],
  ]);
  console.log('');
  console.log(chalk.dim(`Tip: run \`${cliName} --help\` to see the primary option set.`));
}

function printDebugOptionGroup(entries: Array<[string, string]>): void {
  const flagWidth = Math.max(...entries.map(([flag]) => flag.length));
  entries.forEach(([flag, description]) => {
    const label = chalk.cyan(flag.padEnd(flagWidth + 2));
    console.log(`  ${label}${description}`);
  });
}

function resolveWaitFlag({
  waitFlag,
  noWaitFlag,
  model,
  engine,
}: {
  waitFlag?: boolean;
  noWaitFlag?: boolean;
  model: ModelName;
  engine: EngineMode;
}): boolean {
  if (waitFlag === true) return true;
  if (noWaitFlag === true) return false;
  return defaultWaitPreference(model, engine);
}

function applyBrowserDefaultsFromConfig(options: CliOptions, config: UserConfig): void {
  const browser = config.browser;
  if (!browser) return;
  const source = (key: keyof CliOptions) => program.getOptionValueSource?.(key as string);

  if (source('browserChromeProfile') === 'default' && browser.chromeProfile !== undefined) {
    options.browserChromeProfile = browser.chromeProfile ?? undefined;
  }
  if (source('browserChromePath') === 'default' && browser.chromePath !== undefined) {
    options.browserChromePath = browser.chromePath ?? undefined;
  }
  if (source('browserUrl') === 'default' && browser.url !== undefined) {
    options.browserUrl = browser.url;
  }
  if (source('browserTimeout') === 'default' && typeof browser.timeoutMs === 'number') {
    options.browserTimeout = String(browser.timeoutMs);
  }
  if (source('browserInputTimeout') === 'default' && typeof browser.inputTimeoutMs === 'number') {
    options.browserInputTimeout = String(browser.inputTimeoutMs);
  }
  if (source('browserHeadless') === 'default' && browser.headless !== undefined) {
    options.browserHeadless = browser.headless;
  }
  if (source('browserHideWindow') === 'default' && browser.hideWindow !== undefined) {
    options.browserHideWindow = browser.hideWindow;
  }
  if (source('browserKeepBrowser') === 'default' && browser.keepBrowser !== undefined) {
    options.browserKeepBrowser = browser.keepBrowser;
  }
}

program.action(async function (this: Command) {
  const options = this.optsWithGlobals() as CliOptions;
  await runRootCommand(options);
});

await program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof Error) {
    if (!isErrorLogged(error)) {
      console.error(chalk.red('✖'), error.message);
    }
  } else {
    console.error(chalk.red('✖'), error);
  }
  process.exitCode = 1;
});
