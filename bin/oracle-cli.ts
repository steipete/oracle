#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Command, Option } from 'commander';
import type { OptionValues } from 'commander';
// Allow `npx @steipete/oracle oracle-mcp` to resolve the MCP server even though npx runs the default binary.
if (process.argv[2] === 'oracle-mcp') {
  const { startMcpServer } = await import('../src/mcp/server.js');
  await startMcpServer();
  process.exit(0);
}
import { resolveEngine, type EngineMode, defaultWaitPreference } from '../src/cli/engine.js';
import { shouldRequirePrompt } from '../src/cli/promptRequirement.js';
import chalk from 'chalk';
import type { SessionMetadata, SessionMode, BrowserSessionConfig } from '../src/sessionStore.js';
import { sessionStore, pruneOldSessions } from '../src/sessionStore.js';
import { DEFAULT_MODEL, MODEL_CONFIGS, runOracle, readFiles, estimateRequestTokens, buildRequestBody } from '../src/oracle.js';
import type { ModelName, PreviewMode, RunOracleOptions } from '../src/oracle.js';
import { CHATGPT_URL, normalizeChatgptUrl } from '../src/browserMode.js';
import { createRemoteBrowserExecutor } from '../src/remote/client.js';
import { applyHelpStyling } from '../src/cli/help.js';
import {
  collectPaths,
  collectModelList,
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
  parseTimeoutOption,
  mergePathLikeOptions,
} from '../src/cli/options.js';
import { copyToClipboard } from '../src/cli/clipboard.js';
import { buildMarkdownBundle } from '../src/cli/markdownBundle.js';
import { shouldDetachSession } from '../src/cli/detach.js';
import { applyHiddenAliases } from '../src/cli/hiddenAliases.js';
import { buildBrowserConfig, resolveBrowserModelLabel } from '../src/cli/browserConfig.js';
import { performSessionRun } from '../src/cli/sessionRunner.js';
import type { BrowserSessionRunnerDeps } from '../src/browser/sessionRunner.js';
import { attachSession, showStatus, formatCompletionSummary } from '../src/cli/sessionDisplay.js';
import type { ShowStatusOptions } from '../src/cli/sessionDisplay.js';
import { formatCompactNumber } from '../src/cli/format.js';
import { formatIntroLine } from '../src/cli/tagline.js';
import { warnIfOversizeBundle } from '../src/cli/bundleWarnings.js';
import { formatRenderedMarkdown } from '../src/cli/renderOutput.js';
import { resolveRenderFlag, resolveRenderPlain } from '../src/cli/renderFlags.js';
import { resolveGeminiModelId } from '../src/oracle/gemini.js';
import { handleSessionCommand, type StatusOptions, formatSessionCleanupMessage } from '../src/cli/sessionCommand.js';
import { isErrorLogged } from '../src/cli/errorUtils.js';
import { handleSessionAlias, handleStatusFlag } from '../src/cli/rootAlias.js';
import { resolveOutputPath } from '../src/cli/writeOutputPath.js';
import { getCliVersion } from '../src/version.js';
import { runDryRunSummary, runBrowserPreview } from '../src/cli/dryRun.js';
import { launchTui } from '../src/cli/tui/index.js';
import {
  resolveNotificationSettings,
  deriveNotificationSettingsFromMetadata,
  type NotificationSettings,
} from '../src/cli/notifier.js';
import { loadUserConfig, type UserConfig } from '../src/config.js';
import { shouldBlockDuplicatePrompt } from '../src/cli/duplicatePromptGuard.js';

interface CliOptions extends OptionValues {
  prompt?: string;
  message?: string;
  file?: string[];
  include?: string[];
  files?: string[];
  path?: string[];
  paths?: string[];
  render?: boolean;
  model: string;
  models?: string[];
  force?: boolean;
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
  timeout?: number | 'auto';
  browserChromeProfile?: string;
  browserChromePath?: string;
  browserCookiePath?: string;
  chatgptUrl?: string;
  browserUrl?: string;
  browserTimeout?: string;
  browserInputTimeout?: string;
  browserNoCookieSync?: boolean;
  browserInlineCookiesFile?: string;
  browserCookieNames?: string;
  browserInlineCookies?: string;
  browserHeadless?: boolean;
  browserHideWindow?: boolean;
  browserKeepBrowser?: boolean;
  browserAllowCookieErrors?: boolean;
  browserInlineFiles?: boolean;
  browserBundleFiles?: boolean;
  remoteChrome?: string;
  remoteHost?: string;
  remoteToken?: string;
  copyMarkdown?: boolean;
  copy?: boolean;
  verbose?: boolean;
  debugHelp?: boolean;
  heartbeat?: number;
  status?: boolean;
  dryRun?: boolean;
  wait?: boolean;
  noWait?: boolean;
  baseUrl?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
  showModelId?: boolean;
  retainHours?: number;
  writeOutput?: string;
  writeOutputPath?: string;
}

type ResolvedCliOptions = Omit<CliOptions, 'model'> & {
  model: ModelName;
  models?: ModelName[];
  effectiveModelId?: string;
  writeOutputPath?: string;
};

const VERSION = getCliVersion();
const CLI_ENTRYPOINT = fileURLToPath(import.meta.url);
const rawCliArgs = process.argv.slice(2);
const userCliArgs = rawCliArgs[0] === CLI_ENTRYPOINT ? rawCliArgs.slice(1) : rawCliArgs;
const isTty = process.stdout.isTTY;
const tuiEnabled = () => isTty && process.env.ORACLE_NO_TUI !== '1';

const program = new Command();
let introPrinted = false;
program.hook('preAction', () => {
  if (introPrinted) return;
  console.log(formatIntroLine(VERSION, { env: process.env, richTty: isTty }));
  introPrinted = true;
});
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
  .description('One-shot GPT-5.1 Pro / GPT-5.1 / GPT-5.1 Codex tool for hard questions that benefit from large file context and server-side search.')
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
  .addOption(
    new Option('--files <paths...>', 'Alias for --file.')
      .argParser(collectPaths)
      .default([])
      .hideHelp(),
  )
  .addOption(
    new Option('--path <paths...>', 'Alias for --file.')
      .argParser(collectPaths)
      .default([])
      .hideHelp(),
  )
  .addOption(
    new Option('--paths <paths...>', 'Alias for --file.')
      .argParser(collectPaths)
      .default([])
      .hideHelp(),
  )
  .addOption(
    new Option(
      '--copy-markdown',
      'Copy the assembled markdown bundle to the clipboard; pair with --render to print it too.',
    ).default(false),
  )
  .addOption(new Option('--copy').hideHelp().default(false))
  .option('-s, --slug <words>', 'Custom session slug (3-5 words).')
  .option(
    '-m, --model <model>',
    'Model to target (gpt-5.1-pro default; also gpt-5-pro, gpt-5.1, gpt-5.1-codex API-only, gemini-3-pro, claude-4.5-sonnet, claude-4.1-opus, or ChatGPT labels like "5.1 Instant" for browser runs).',
    normalizeModelOption,
  )
  .addOption(
    new Option(
      '--models <models>',
      'Comma-separated API model list to query in parallel (e.g., "gpt-5.1-pro,gemini-3-pro").',
    )
      .argParser(collectModelList)
      .default([]),
  )
  .addOption(
    new Option(
      '-e, --engine <mode>',
      'Execution engine (api | browser). Engine is preferred; --mode is a legacy alias. If omitted, oracle picks api when OPENAI_API_KEY is set, otherwise browser.',
    ).choices(['api', 'browser'])
  )
  .addOption(
    new Option('--mode <mode>', 'Alias for --engine (api | browser).').choices(['api', 'browser']).hideHelp(),
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
  .addOption(
    new Option(
      '--timeout <seconds|auto>',
      'Overall timeout before aborting the API call (auto = 60m for gpt-5.1-pro, 120s otherwise).',
    )
      .argParser(parseTimeoutOption)
      .default('auto'),
  )
  .addOption(
    new Option(
      '--preview [mode]',
      '(alias) Preview the request without calling the model (summary | json | full). Deprecated: use --dry-run instead.',
    )
      .hideHelp()
      .choices(['summary', 'json', 'full'])
      .preset('summary'),
  )
  .addOption(
    new Option('--dry-run [mode]', 'Preview without calling the model (summary | json | full).')
      .choices(['summary', 'json', 'full'])
      .preset('summary')
      .default(false),
  )
  .addOption(new Option('--exec-session <id>').hideHelp())
  .addOption(new Option('--session <id>').hideHelp())
  .addOption(new Option('--status', 'Show stored sessions (alias for `oracle status`).').default(false).hideHelp())
  .option(
    '--render-markdown',
    'Print the assembled markdown bundle for prompt + files and exit; pair with --copy to put it on the clipboard.',
    false,
  )
  .option('--render', 'Alias for --render-markdown.', false)
  .option('--render-plain', 'Render markdown without ANSI/highlighting (use plain text even in a TTY).', false)
  .option(
    '--write-output <path>',
    'Write only the final assistant message to this file (overwrites; multi-model appends .<model> before the extension).',
  )
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
  .option('--azure-endpoint <url>', 'Azure OpenAI Endpoint (e.g. https://resource.openai.azure.com/).')
  .option('--azure-deployment <name>', 'Azure OpenAI Deployment Name.')
  .option('--azure-api-version <version>', 'Azure OpenAI API Version.')
  .addOption(new Option('--browser', '(deprecated) Use --engine browser instead.').default(false).hideHelp())
  .addOption(new Option('--browser-chrome-profile <name>', 'Chrome profile name/path for cookie reuse.').hideHelp())
  .addOption(new Option('--browser-chrome-path <path>', 'Explicit Chrome or Chromium executable path.').hideHelp())
  .addOption(
    new Option('--browser-cookie-path <path>', 'Explicit Chrome/Chromium cookie DB path for session reuse.'),
  )
  .addOption(
    new Option(
      '--chatgpt-url <url>',
      `Override the ChatGPT web URL (e.g., workspace/folder like https://chatgpt.com/g/.../project; default ${CHATGPT_URL}).`,
    ),
  )
  .addOption(new Option('--browser-url <url>', `Alias for --chatgpt-url (default ${CHATGPT_URL}).`).hideHelp())
  .addOption(new Option('--browser-timeout <ms|s|m>', 'Maximum time to wait for an answer (default 1200s / 20m).').hideHelp())
  .addOption(
    new Option('--browser-input-timeout <ms|s|m>', 'Maximum time to wait for the prompt textarea (default 30s).').hideHelp(),
  )
  .addOption(new Option('--browser-cookie-names <names>', 'Comma-separated cookie allowlist for sync.').hideHelp())
  .addOption(
    new Option('--browser-inline-cookies <jsonOrBase64>', 'Inline cookies payload (JSON array or base64-encoded JSON).').hideHelp(),
  )
  .addOption(
    new Option('--browser-inline-cookies-file <path>', 'Load inline cookies from file (JSON or base64 JSON).').hideHelp(),
  )
  .addOption(new Option('--browser-no-cookie-sync', 'Skip copying cookies from Chrome.').hideHelp())
  .addOption(new Option('--browser-headless', 'Launch Chrome in headless mode.').hideHelp())
  .addOption(new Option('--browser-hide-window', 'Hide the Chrome window after launch (macOS headful only).').hideHelp())
  .addOption(new Option('--browser-keep-browser', 'Keep Chrome running after completion.').hideHelp())
  .addOption(
    new Option('--browser-allow-cookie-errors', 'Continue even if Chrome cookies cannot be copied.').hideHelp(),
  )
  .addOption(
    new Option(
      '--remote-chrome <host:port>',
      'Connect to remote Chrome DevTools Protocol (e.g., 192.168.1.10:9222 or [2001:db8::1]:9222 for IPv6).',
    ),
  )
  .addOption(new Option('--remote-host <host:port>', 'Delegate browser runs to a remote `oracle serve` instance.'))
  .addOption(new Option('--remote-token <token>', 'Access token for the remote `oracle serve` instance.'))
  .addOption(
    new Option('--browser-inline-files', 'Paste files directly into the ChatGPT composer instead of uploading attachments.').default(false),
  )
  .addOption(new Option('--browser-bundle-files', 'Bundle all attachments into a single archive before uploading.').default(false))
  .option(
    '--retain-hours <hours>',
    'Prune stored sessions older than this many hours before running (set 0 to disable).',
    parseFloatOption,
  )
  .option('--force', 'Force start a new session even if an identical prompt is already running.', false)
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

  # Build, print, and copy a markdown bundle (semi-manual)
  oracle --render --copy -p "Review the TS data layer" --file "src/**/*.ts" --file "!src/**/*.test.ts"
`,
);

program
  .command('serve')
  .description('Run Oracle browser automation as a remote service for other machines.')
  .option('--host <address>', 'Interface to bind (default 0.0.0.0).')
  .option('--port <number>', 'Port to listen on (default random).', parseIntOption)
  .option('--token <value>', 'Access token clients must provide (random if omitted).')
  .action(async (commandOptions) => {
    const { serveRemote } = await import('../src/remote/server.js');
    await serveRemote({
      host: commandOptions.host,
      port: commandOptions.port,
      token: commandOptions.token,
    });
  });

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
  .option('--model <name>', 'Filter sessions/output for a specific model.', '')
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
  .option('--model <name>', 'Filter sessions/output for a specific model.', '')
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
      const result = await sessionStore.deleteOlderThan({ hours, includeAll });
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
  const azure =
    options.azureEndpoint || overrides.azure?.endpoint
      ? {
          endpoint: overrides.azure?.endpoint ?? options.azureEndpoint,
          deployment: overrides.azure?.deployment ?? options.azureDeployment,
          apiVersion: overrides.azure?.apiVersion ?? options.azureApiVersion,
        }
      : undefined;

  return {
    prompt: options.prompt,
    model: options.model,
    models: overrides.models ?? options.models,
    effectiveModelId: overrides.effectiveModelId ?? options.effectiveModelId ?? options.model,
    file: overrides.file ?? options.file ?? [],
    slug: overrides.slug ?? options.slug,
    filesReport: overrides.filesReport ?? options.filesReport,
    maxInput: overrides.maxInput ?? options.maxInput,
    maxOutput: overrides.maxOutput ?? options.maxOutput,
    system: overrides.system ?? options.system,
    timeoutSeconds: overrides.timeoutSeconds ?? (options.timeout as number | 'auto' | undefined),
    silent: overrides.silent ?? options.silent,
    search: overrides.search ?? options.search,
    preview: overrides.preview ?? undefined,
    previewMode: overrides.previewMode ?? options.previewMode,
    apiKey: overrides.apiKey ?? options.apiKey,
    baseUrl: normalizedBaseUrl,
    azure,
    sessionId: overrides.sessionId ?? options.sessionId,
    verbose: overrides.verbose ?? options.verbose,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? resolveHeartbeatIntervalMs(options.heartbeat),
    browserInlineFiles: overrides.browserInlineFiles ?? options.browserInlineFiles ?? false,
    browserBundleFiles: overrides.browserBundleFiles ?? options.browserBundleFiles ?? false,
    background: overrides.background ?? undefined,
    renderPlain: overrides.renderPlain ?? options.renderPlain ?? false,
    writeOutputPath: overrides.writeOutputPath ?? options.writeOutputPath,
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
    model: (stored.model as ModelName) ?? DEFAULT_MODEL,
    models: stored.models as ModelName[] | undefined,
    effectiveModelId: stored.effectiveModelId ?? stored.model,
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
    azure: stored.azure,
    sessionId: metadata.id,
    verbose: stored.verbose,
    heartbeatIntervalMs: stored.heartbeatIntervalMs,
    browserInlineFiles: stored.browserInlineFiles,
    browserBundleFiles: stored.browserBundleFiles,
    background: stored.background,
    renderPlain: stored.renderPlain,
    writeOutputPath: stored.writeOutputPath,
  };
}

function getSessionMode(metadata: SessionMetadata): SessionMode {
  return metadata.mode ?? metadata.options?.mode ?? 'api';
}

function getBrowserConfigFromMetadata(metadata: SessionMetadata): BrowserSessionConfig | undefined {
  return metadata.options?.browserConfig ?? metadata.browser?.config;
}

async function runRootCommand(options: CliOptions): Promise<void> {
  if (process.env.ORACLE_FORCE_TUI === '1') {
    await sessionStore.ensureStorage();
    await launchTui({ version: VERSION, printIntro: false });
    return;
  }
  const userConfig = (await loadUserConfig()).config;
  const helpRequested = rawCliArgs.some((arg: string) => arg === '--help' || arg === '-h');
  const multiModelProvided = Array.isArray(options.models) && options.models.length > 0;
  if (multiModelProvided) {
    const modelFromConfigOrCli = normalizeModelOption(options.model ?? userConfig.model ?? '');
    if (modelFromConfigOrCli) {
      throw new Error('--models cannot be combined with --model.');
    }
  }
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
  const previewMode = resolvePreviewMode(options.dryRun || options.preview);
  const mergedFileInputs = mergePathLikeOptions(
    options.file,
    options.include,
    options.files,
    options.path,
    options.paths,
  );
  if (mergedFileInputs.length > 0) {
    options.file = mergedFileInputs;
  }
  const copyMarkdown = options.copyMarkdown || options.copy;
  const renderMarkdown = resolveRenderFlag(options.render, options.renderMarkdown);
  const renderPlain = resolveRenderPlain(options.renderPlain, options.render, options.renderMarkdown);

  const applyRetentionOption = (): void => {
    if (optionUsesDefault('retainHours') && typeof userConfig.sessionRetentionHours === 'number') {
      options.retainHours = userConfig.sessionRetentionHours;
    }
    const envRetention = process.env.ORACLE_RETAIN_HOURS;
    if (optionUsesDefault('retainHours') && envRetention) {
      const parsed = Number.parseFloat(envRetention);
      if (!Number.isNaN(parsed)) {
        options.retainHours = parsed;
      }
    }
  };
  applyRetentionOption();

  const remoteHost =
    options.remoteHost ?? userConfig.remoteHost ?? userConfig.remote?.host ?? process.env.ORACLE_REMOTE_HOST;
  const remoteToken =
    options.remoteToken ?? userConfig.remoteToken ?? userConfig.remote?.token ?? process.env.ORACLE_REMOTE_TOKEN;
  if (remoteHost) {
    console.log(chalk.dim(`Remote browser host detected: ${remoteHost}`));
  }

  if (userCliArgs.length === 0) {
    if (tuiEnabled()) {
      await launchTui({ version: VERSION, printIntro: false });
      return;
    }
    console.log(chalk.yellow('No prompt or subcommand supplied. See `oracle --help` for usage.'));
    program.help({ error: false });
    return;
  }
  const retentionHours = typeof options.retainHours === 'number' ? options.retainHours : undefined;
  await sessionStore.ensureStorage();
  await pruneOldSessions(retentionHours, (message) => console.log(chalk.dim(message)));

  if (options.debugHelp) {
    printDebugHelp(program.name());
    return;
  }
  if (options.dryRun && options.renderMarkdown) {
    throw new Error('--dry-run cannot be combined with --render-markdown.');
  }

  const preferredEngine = options.engine ?? userConfig.engine;
  let engine: EngineMode = resolveEngine({ engine: preferredEngine, browserFlag: options.browser, env: process.env });
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

  if (remoteHost && engine !== 'browser') {
    throw new Error('--remote-host requires --engine browser.');
  }
  if (remoteHost && options.remoteChrome) {
    throw new Error('--remote-host cannot be combined with --remote-chrome.');
  }

  if (optionUsesDefault('azureEndpoint')) {
    if (process.env.AZURE_OPENAI_ENDPOINT) {
      options.azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    } else if (userConfig.azure?.endpoint) {
      options.azureEndpoint = userConfig.azure.endpoint;
    }
  }
  if (optionUsesDefault('azureDeployment')) {
    if (process.env.AZURE_OPENAI_DEPLOYMENT) {
      options.azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    } else if (userConfig.azure?.deployment) {
      options.azureDeployment = userConfig.azure.deployment;
    }
  }
  if (optionUsesDefault('azureApiVersion')) {
    if (process.env.AZURE_OPENAI_API_VERSION) {
      options.azureApiVersion = process.env.AZURE_OPENAI_API_VERSION;
    } else if (userConfig.azure?.apiVersion) {
      options.azureApiVersion = userConfig.azure.apiVersion;
    }
  }

  const normalizedMultiModels: ModelName[] = multiModelProvided
    ? Array.from(new Set(options.models!.map((entry) => resolveApiModel(entry))))
    : [];
  const cliModelArg = normalizeModelOption(options.model) || (multiModelProvided ? '' : DEFAULT_MODEL);
  const resolvedModelCandidate: ModelName = multiModelProvided
    ? normalizedMultiModels[0]
    : engine === 'browser'
      ? inferModelFromLabel(cliModelArg || DEFAULT_MODEL)
      : resolveApiModel(cliModelArg || DEFAULT_MODEL);
  const primaryModelCandidate = normalizedMultiModels[0] ?? resolvedModelCandidate;
  const isGemini = primaryModelCandidate.startsWith('gemini');
  const isCodex = primaryModelCandidate.startsWith('gpt-5.1-codex');
  const isClaude = primaryModelCandidate.startsWith('claude');
  const userForcedBrowser = options.browser || options.engine === 'browser';
  const hasNonGptBrowserTarget =
    (engine === 'browser' || userForcedBrowser) &&
    (normalizedMultiModels.length > 0
      ? normalizedMultiModels.some((model) => !model.startsWith('gpt-'))
      : !resolvedModelCandidate.startsWith('gpt-'));
  if (hasNonGptBrowserTarget) {
    throw new Error(
      'Browser engine only supports GPT-series ChatGPT models. Re-run with --engine api for Grok, Claude, Gemini, or other non-GPT models.'
    );
  }
  if (isGemini && userForcedBrowser) {
    throw new Error('Gemini is only supported via API. Use --engine api.');
  }
  if (isGemini && engine === 'browser') {
    engine = 'api';
  }
  if (isClaude && engine === 'browser') {
    console.log(chalk.dim('Browser engine is not supported for Claude models; switching to API.'));
    engine = 'api';
  }
  if (isCodex && engine === 'browser') {
    console.log(chalk.dim('Browser engine is not supported for gpt-5.1-codex; switching to API.'));
    engine = 'api';
  }
  if (normalizedMultiModels.length > 0) {
    engine = 'api';
  }
  if (remoteHost && normalizedMultiModels.length > 0) {
    throw new Error('--remote-host does not support --models yet. Use API engine locally instead.');
  }
  const resolvedModel: ModelName =
    normalizedMultiModels[0] ?? (isGemini ? resolveApiModel(cliModelArg) : resolvedModelCandidate);
  const effectiveModelId = resolvedModel.startsWith('gemini')
    ? resolveGeminiModelId(resolvedModel)
    : MODEL_CONFIGS[resolvedModel]?.apiModel ?? resolvedModel;
  const resolvedBaseUrl = normalizeBaseUrl(
    options.baseUrl ?? (isClaude ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL),
  );
  const { models: _rawModels, ...optionsWithoutModels } = options;
  const resolvedOptions: ResolvedCliOptions = { ...optionsWithoutModels, model: resolvedModel };
  if (normalizedMultiModels.length > 0) {
    resolvedOptions.models = normalizedMultiModels;
  }
  resolvedOptions.baseUrl = resolvedBaseUrl;
  resolvedOptions.effectiveModelId = effectiveModelId;
  resolvedOptions.writeOutputPath = resolveOutputPath(options.writeOutput, process.cwd());

  // Decide whether to block until completion:
  // - explicit --wait / --no-wait wins
  // - otherwise block for fast models (gpt-5.1, browser) and detach by default for pro API runs
  let waitPreference = resolveWaitFlag({
    waitFlag: options.wait,
    noWaitFlag: options.noWait,
    model: resolvedModel,
    engine,
  });
  if (remoteHost && !waitPreference) {
    console.log(chalk.dim('Remote browser runs require --wait; ignoring --no-wait.'));
    waitPreference = true;
  }

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

  if (renderMarkdown || copyMarkdown) {
    if (!options.prompt) {
      throw new Error('Prompt is required when using --render-markdown or --copy-markdown.');
    }
    const bundle = await buildMarkdownBundle(
      { prompt: options.prompt, file: options.file, system: options.system },
      { cwd: process.cwd() },
    );
    const modelConfig = MODEL_CONFIGS[resolvedModel];
    const requestBody = buildRequestBody({
      modelConfig,
      systemPrompt: bundle.systemPrompt,
      userPrompt: bundle.promptWithFiles,
      searchEnabled: options.search !== false,
      background: false,
      storeResponse: false,
    });
    const estimatedTokens = estimateRequestTokens(requestBody, modelConfig);
    const warnThreshold = Math.min(196_000, modelConfig.inputLimit ?? 196_000);
    warnIfOversizeBundle(estimatedTokens, warnThreshold, console.log);
    if (renderMarkdown) {
      const output = renderPlain
        ? bundle.markdown
        : await formatRenderedMarkdown(bundle.markdown, { richTty: isTty });
      // Trim trailing newlines from the rendered bundle so we print exactly one blank before the summary line.
      console.log(output.replace(/\n+$/u, ''));
    }
    if (copyMarkdown) {
      const result = await copyToClipboard(bundle.markdown);
      if (result.success) {
        const filesPart = bundle.files.length > 0 ? `; ${bundle.files.length} files` : '';
        const summary = `Copied markdown to clipboard (~${formatCompactNumber(estimatedTokens)} tokens${filesPart}).`;
        console.log(chalk.green(summary));
      } else {
        const reason = result.error instanceof Error ? result.error.message : String(result.error ?? 'unknown error');
        console.log(
          chalk.dim(
            `Copy failed (${reason}); markdown not printed. Re-run with --render-markdown if you need the content.`,
          ),
        );
      }
    }
    return;
  }

  if (previewMode) {
    if (!options.prompt) {
      throw new Error('Prompt is required when using --dry-run/preview.');
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
    // API dry-run/preview path
    if (previewMode === 'summary') {
      await runDryRunSummary(
        {
          engine,
          runOptions,
          cwd: process.cwd(),
          version: VERSION,
          log: console.log,
        },
        {},
      );
      return;
    }
    await runDryRunSummary(
      {
        engine,
        runOptions,
        cwd: process.cwd(),
        version: VERSION,
        log: console.log,
      },
      {},
    );
    return;
  }

  if (!options.prompt) {
    throw new Error('Prompt is required when starting a new session.');
  }

  if (userConfig.promptSuffix) {
    options.prompt = `${options.prompt.trim()}\n${userConfig.promptSuffix}`;
  }
  resolvedOptions.prompt = options.prompt;

  const duplicateBlocked = await shouldBlockDuplicatePrompt({
    prompt: resolvedOptions.prompt,
    force: options.force,
    sessionStore,
    log: console.log,
  });
  if (duplicateBlocked) {
    process.exitCode = 1;
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
      ? await buildBrowserConfig({
          ...options,
          model: resolvedModel,
          browserModelLabel: browserModelLabelOverride,
        })
      : undefined;

  let browserDeps: BrowserSessionRunnerDeps | undefined;
  if (browserConfig && remoteHost) {
    browserDeps = {
      executeBrowser: createRemoteBrowserExecutor({ host: remoteHost, token: remoteToken }),
    };
    console.log(chalk.dim(`Routing browser automation to remote host ${remoteHost}`));
  }
  const remoteExecutionActive = Boolean(browserDeps);

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
        browserConfig,
      },
      {},
    );
    return;
  }

  await sessionStore.ensureStorage();
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
  const sessionMeta = await sessionStore.createSession(
    {
      ...baseRunOptions,
      mode: sessionMode,
      browserConfig,
    },
    process.cwd(),
    notifications,
  );
  const liveRunOptions: RunOracleOptions = {
    ...baseRunOptions,
    sessionId: sessionMeta.id,
    effectiveModelId,
  };
  const disableDetachEnv = process.env.ORACLE_NO_DETACH === '1';
  const detachAllowed = remoteExecutionActive
    ? false
    : shouldDetachSession({
        engine,
        model: resolvedModel,
        waitPreference,
        disableDetachEnv,
      });
  const detached = !detachAllowed
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
    console.log(
      chalk.dim('Pro runs can take up to 60 minutes (usually 10-15). Add --wait to stay attached.'),
    );
    return;
  }

  if (detached === false) {
    await runInteractiveSession(
      sessionMeta,
      liveRunOptions,
      sessionMode,
      browserConfig,
      false,
      notifications,
      userConfig,
      true,
      browserDeps,
    );
    return;
  }
  if (detached) {
    console.log(chalk.blue(`Reattach via: oracle session ${sessionMeta.id}`));
    await attachSession(sessionMeta.id, { suppressMetadata: true });
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
  suppressSummary = false,
  browserDeps?: BrowserSessionRunnerDeps,
): Promise<void> {
  const { logLine, writeChunk, stream } = sessionStore.createLogWriter(sessionMeta.id);
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
    // runOracle handles stdout; keep this write hook for session logs only to avoid double-printing
    writeChunk(chunk);
    return true;
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
      browserDeps,
    });
    const latest = await sessionStore.readSession(sessionMeta.id);
    if (!suppressSummary) {
      const summary = latest ? formatCompletionSummary(latest, { includeSlug: true }) : null;
      if (summary) {
        console.log('\n' + chalk.green.bold(summary));
        logLine(summary); // plain text in log, colored on stdout
      }
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
  const metadata = await sessionStore.readSession(sessionId);
  if (!metadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  const runOptions = buildRunOptionsFromMetadata(metadata);
  const sessionMode = getSessionMode(metadata);
  const browserConfig = getBrowserConfigFromMetadata(metadata);
  const { logLine, writeChunk, stream } = sessionStore.createLogWriter(sessionId);
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
    ['--chatgpt-url <url>', 'Override the ChatGPT web URL (workspace/folder targets).'],
    ['--browser-chrome-profile <name>', 'Reuse cookies from a specific Chrome profile.'],
    ['--browser-chrome-path <path>', 'Point to a custom Chrome/Chromium binary.'],
    ['--browser-cookie-path <path>', 'Use a specific Chrome/Chromium cookie store file.'],
    ['--browser-url <url>', 'Alias for --chatgpt-url.'],
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

  const configuredChatgptUrl = browser.chatgptUrl ?? browser.url;
  if (source('chatgptUrl') === 'default' && configuredChatgptUrl !== undefined) {
    try {
      options.chatgptUrl = normalizeChatgptUrl(configuredChatgptUrl ?? '', CHATGPT_URL);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  if (source('browserChromeProfile') === 'default' && browser.chromeProfile !== undefined) {
    options.browserChromeProfile = browser.chromeProfile ?? undefined;
  }
  if (source('browserChromePath') === 'default' && browser.chromePath !== undefined) {
    options.browserChromePath = browser.chromePath ?? undefined;
  }
  if (source('browserCookiePath') === 'default' && browser.chromeCookiePath !== undefined) {
    options.browserCookiePath = browser.chromeCookiePath ?? undefined;
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

async function main(): Promise<void> {
  const parsePromise = program.parseAsync(process.argv);
  const sigintPromise = once(process, 'SIGINT').then(() => 'sigint' as const);
  const result = await Promise.race([parsePromise.then(() => 'parsed' as const), sigintPromise]);
  if (result === 'sigint') {
    console.log(chalk.yellow('\nCancelled.'));
    process.exitCode = 130;
  }
}

void main().catch((error: unknown) => {
  if (error instanceof Error) {
    if (!isErrorLogged(error)) {
      console.error(chalk.red('✖'), error.message);
    }
  } else {
    console.error(chalk.red('✖'), error);
  }
  process.exitCode = 1;
});
