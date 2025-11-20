import chalk from 'chalk';
import type { RunOracleOptions } from '../oracle.js';
import { formatElapsed } from '../oracle.js';
import type { BrowserSessionConfig, BrowserRuntimeMetadata } from '../sessionStore.js';
import { runBrowserMode } from '../browserMode.js';
import type { BrowserRunResult } from '../browserMode.js';
import { assembleBrowserPrompt } from './prompt.js';
import { BrowserAutomationError } from '../oracle/errors.js';
import type { BrowserLogger } from './types.js';

export interface BrowserExecutionResult {
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  elapsedMs: number;
  runtime: BrowserRuntimeMetadata;
  answerText: string;
}

interface RunBrowserSessionArgs {
  runOptions: RunOracleOptions;
  browserConfig: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
}

export interface BrowserSessionRunnerDeps {
  assemblePrompt?: typeof assembleBrowserPrompt;
  executeBrowser?: typeof runBrowserMode;
}

export async function runBrowserSessionExecution(
  { runOptions, browserConfig, cwd, log }: RunBrowserSessionArgs,
  deps: BrowserSessionRunnerDeps = {},
): Promise<BrowserExecutionResult> {
  if (runOptions.model.startsWith('gemini')) {
    throw new BrowserAutomationError('Gemini models are not available in browser mode. Re-run with --engine api.', {
      stage: 'preflight',
    });
  }
  const assemblePrompt = deps.assemblePrompt ?? assembleBrowserPrompt;
  const executeBrowser = deps.executeBrowser ?? runBrowserMode;
  const promptArtifacts = await assemblePrompt(runOptions, { cwd });
  if (runOptions.verbose) {
    log(
      chalk.dim(
        `[verbose] Browser config: ${JSON.stringify({
          ...browserConfig,
        })}`,
      ),
    );
    log(chalk.dim(`[verbose] Browser prompt length: ${promptArtifacts.composerText.length} chars`));
    if (promptArtifacts.attachments.length > 0) {
      const attachmentList = promptArtifacts.attachments.map((attachment) => attachment.displayPath).join(', ');
      log(chalk.dim(`[verbose] Browser attachments: ${attachmentList}`));
      if (promptArtifacts.bundled) {
        log(
          chalk.yellow(
            `[browser] Bundled ${promptArtifacts.bundled.originalCount} files into ${promptArtifacts.bundled.bundlePath}.`,
          ),
        );
      }
    } else if (runOptions.file && runOptions.file.length > 0 && runOptions.browserInlineFiles) {
      log(chalk.dim('[verbose] Browser inline file fallback enabled (pasting file contents).'));
    }
  }
  const headerLine = `launching browser mode (${runOptions.model}) with ~${promptArtifacts.estimatedInputTokens.toLocaleString()} tokens`;
  if (promptArtifacts.bundled) {
    log(chalk.dim(`[browser] Packed ${promptArtifacts.bundled.originalCount} files into 1 bundle.`));
  }
  const automationLogger: BrowserLogger = ((message?: string) => {
    if (!runOptions.verbose) return;
    if (typeof message === 'string') {
      log(message);
    }
  }) as BrowserLogger;
  automationLogger.verbose = Boolean(runOptions.verbose);
  automationLogger.sessionLog = runOptions.verbose ? log : (() => {});

  log(headerLine);
  log(chalk.dim('This run can take up to an hour (usually ~10 minutes).'));
  if (runOptions.verbose) {
    log(chalk.dim('Chrome automation does not stream output; this may take a minute...'));
  }
  let browserResult: BrowserRunResult;
  try {
    browserResult = await executeBrowser({
      prompt: promptArtifacts.composerText,
      attachments: promptArtifacts.attachments,
      config: browserConfig,
      log: automationLogger,
      heartbeatIntervalMs: runOptions.heartbeatIntervalMs,
      verbose: runOptions.verbose,
    });
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Browser automation failed.';
    throw new BrowserAutomationError(message, { stage: 'execute-browser' }, error);
  }
  if (!runOptions.silent) {
    log(chalk.bold('Answer:'));
    log(browserResult.answerMarkdown || browserResult.answerText || chalk.dim('(no text output)'));
    log('');
  }
  const answerText = browserResult.answerMarkdown || browserResult.answerText || '';
  const usage = {
    inputTokens: promptArtifacts.estimatedInputTokens,
    outputTokens: browserResult.answerTokens,
    reasoningTokens: 0,
    totalTokens: promptArtifacts.estimatedInputTokens + browserResult.answerTokens,
  };
  const tokensDisplay = `${usage.inputTokens}/${usage.outputTokens}/${usage.reasoningTokens}/${usage.totalTokens}`;
  const tokensLabel = runOptions.verbose ? 'tokens (input/output/reasoning/total)' : 'tok(i/o/r/t)';
  const statsParts = [`${runOptions.model}[browser]`, `${tokensLabel}=${tokensDisplay}`];
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
    answerText,
  };
}
