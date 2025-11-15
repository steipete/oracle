import chalk from 'chalk';
import type { RunOracleOptions } from '../oracle.js';
import { formatElapsed } from '../oracle.js';
import type { BrowserSessionConfig, BrowserRuntimeMetadata } from '../sessionManager.js';
import { runBrowserMode } from '../browserMode.js';
import { assembleBrowserPrompt } from './prompt.js';

export interface BrowserExecutionResult {
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  elapsedMs: number;
  runtime: BrowserRuntimeMetadata;
}

interface RunBrowserSessionArgs {
  runOptions: RunOracleOptions;
  browserConfig: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
  cliVersion: string;
}

interface BrowserSessionRunnerDeps {
  assemblePrompt?: typeof assembleBrowserPrompt;
  executeBrowser?: typeof runBrowserMode;
}

export async function runBrowserSessionExecution(
  { runOptions, browserConfig, cwd, log, cliVersion }: RunBrowserSessionArgs,
  deps: BrowserSessionRunnerDeps = {},
): Promise<BrowserExecutionResult> {
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
    log(chalk.dim(`[verbose] Browser prompt length: ${promptArtifacts.markdown.length} chars`));
  }
  const headerLine = `Oracle (${cliVersion}) launching browser mode (${runOptions.model}) with ~${promptArtifacts.estimatedInputTokens.toLocaleString()} tokens`;
  log(headerLine);
  log(chalk.dim('Chrome automation does not stream output; this may take a minute...'));
  const browserResult = await executeBrowser({
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
