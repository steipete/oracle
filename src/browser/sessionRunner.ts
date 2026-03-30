import chalk from "chalk";
import type { RunOracleOptions } from "../oracle.js";
import { formatTokenCount } from "../oracle/runUtils.js";
import { formatFinishLine } from "../oracle/finishLine.js";
import type {
  BrowserSessionConfig,
  BrowserRuntimeMetadata,
  SessionMetadata,
} from "../sessionStore.js";
import { runBrowserMode } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import { assembleBrowserPrompt } from "./prompt.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserLogger } from "./types.js";
import { estimateTokenCount } from "./utils.js";
import { continueBrowserSession, type ReattachDeps } from "./reattach.js";

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

export interface BrowserSessionRunnerDeps extends ReattachDeps {
  assemblePrompt?: typeof assembleBrowserPrompt;
  executeBrowser?: typeof runBrowserMode;
  continueBrowser?: typeof continueBrowserSession;
  persistRuntimeHint?: (runtime: BrowserRuntimeMetadata) => Promise<void> | void;
}

interface ContinueBrowserSessionArgs extends RunBrowserSessionArgs {
  parentSession: SessionMetadata;
}

export async function runBrowserSessionExecution(
  { runOptions, browserConfig, cwd, log }: RunBrowserSessionArgs,
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
    log(chalk.dim(`[verbose] Browser prompt length: ${promptArtifacts.composerText.length} chars`));
    if (promptArtifacts.attachments.length > 0) {
      const attachmentList = promptArtifacts.attachments
        .map((attachment) => attachment.displayPath)
        .join(", ");
      log(chalk.dim(`[verbose] Browser attachments: ${attachmentList}`));
      if (promptArtifacts.bundled) {
        log(
          chalk.yellow(
            `[browser] Bundled ${promptArtifacts.bundled.originalCount} files into ${promptArtifacts.bundled.bundlePath}.`,
          ),
        );
      }
    } else if (
      runOptions.file &&
      runOptions.file.length > 0 &&
      promptArtifacts.attachmentMode === "inline"
    ) {
      log(chalk.dim("[verbose] Browser will paste file contents inline (no uploads)."));
    }
  }
  if (promptArtifacts.bundled) {
    log(
      chalk.dim(
        `Packed ${promptArtifacts.bundled.originalCount} files into 1 bundle (contents counted in token estimate).`,
      ),
    );
  }
  const headerLine = `Launching browser mode (${runOptions.model}) with ~${promptArtifacts.estimatedInputTokens.toLocaleString()} tokens.`;
  const automationLogger: BrowserLogger = ((message?: string) => {
    if (typeof message !== "string") return;
    const shouldAlwaysPrint = message.startsWith("[browser] ") && /fallback|retry/i.test(message);
    if (!runOptions.verbose && !shouldAlwaysPrint) return;
    log(message);
  }) as BrowserLogger;
  automationLogger.verbose = Boolean(runOptions.verbose);
  automationLogger.sessionLog = runOptions.verbose ? log : () => {};

  log(headerLine);
  log(chalk.dim("This run can take up to an hour (usually ~10 minutes)."));
  if (runOptions.verbose) {
    log(chalk.dim("Chrome automation does not stream output; this may take a minute..."));
  }
  const persistRuntimeHint = deps.persistRuntimeHint ?? (() => {});
  let browserResult: BrowserRunResult;
  try {
    browserResult = await executeBrowser({
      prompt: promptArtifacts.composerText,
      attachments: promptArtifacts.attachments,
      fallbackSubmission: promptArtifacts.fallback
        ? {
            prompt: promptArtifacts.fallback.composerText,
            attachments: promptArtifacts.fallback.attachments,
          }
        : undefined,
      config: browserConfig,
      log: automationLogger,
      heartbeatIntervalMs: runOptions.heartbeatIntervalMs,
      verbose: runOptions.verbose,
      runtimeHintCb: async (runtime) => {
        await persistRuntimeHint({
          ...runtime,
          controllerPid: runtime.controllerPid ?? process.pid,
        });
      },
    });
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Browser automation failed.";
    throw new BrowserAutomationError(message, { stage: "execute-browser" }, error);
  }
  if (!runOptions.silent) {
    log(chalk.bold("Answer:"));
    log(browserResult.answerMarkdown || browserResult.answerText || chalk.dim("(no text output)"));
    log("");
  }
  const answerText = browserResult.answerMarkdown || browserResult.answerText || "";
  const usage = {
    inputTokens: promptArtifacts.estimatedInputTokens,
    outputTokens: browserResult.answerTokens,
    reasoningTokens: 0,
    totalTokens: promptArtifacts.estimatedInputTokens + browserResult.answerTokens,
  };
  const tokensDisplay = [
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ]
    .map((value) => formatTokenCount(value))
    .join("/");
  const tokensPart = (() => {
    const parts = tokensDisplay.split("/");
    if (parts.length !== 4) return tokensDisplay;
    return `↑${parts[0]} ↓${parts[1]} ↻${parts[2]} Δ${parts[3]}`;
  })();
  const { line1, line2 } = formatFinishLine({
    elapsedMs: browserResult.tookMs,
    model: `${runOptions.model}[browser]`,
    tokensPart,
    detailParts: [
      runOptions.file && runOptions.file.length > 0 ? `files=${runOptions.file.length}` : null,
    ],
  });
  log(chalk.blue(line1));
  if (line2) {
    log(chalk.dim(line2));
  }
  return {
    usage,
    elapsedMs: browserResult.tookMs,
    runtime: {
      chromePid: browserResult.chromePid,
      chromePort: browserResult.chromePort,
      chromeHost: browserResult.chromeHost,
      userDataDir: browserResult.userDataDir,
      controllerPid: browserResult.controllerPid ?? process.pid,
    },
    answerText,
  };
}

export async function continueBrowserSessionExecution(
  { runOptions, browserConfig, cwd, log, parentSession }: ContinueBrowserSessionArgs,
  deps: BrowserSessionRunnerDeps = {},
): Promise<BrowserExecutionResult> {
  const assemblePrompt = deps.assemblePrompt ?? assembleBrowserPrompt;
  const continueBrowser = deps.continueBrowser ?? continueBrowserSession;
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
      const attachmentList = promptArtifacts.attachments
        .map((attachment) => attachment.displayPath)
        .join(", ");
      log(chalk.dim(`[verbose] Browser follow-up attachments: ${attachmentList}`));
      if (promptArtifacts.bundled) {
        log(
          chalk.yellow(
            `[browser] Bundled ${promptArtifacts.bundled.originalCount} files into ${promptArtifacts.bundled.bundlePath}.`,
          ),
        );
      }
    } else if (
      runOptions.file &&
      runOptions.file.length > 0 &&
      promptArtifacts.attachmentMode === "inline"
    ) {
      log(chalk.dim("[verbose] Browser follow-up will paste file contents inline (no uploads)."));
    }
  }
  if (promptArtifacts.bundled) {
    log(
      chalk.dim(
        `Packed ${promptArtifacts.bundled.originalCount} files into 1 bundle (contents counted in token estimate).`,
      ),
    );
  }
  const runtime = parentSession.browser?.runtime;
  if (!runtime) {
    throw new BrowserAutomationError(
      `Session ${parentSession.id} is missing browser runtime metadata; cannot continue.`,
      { stage: "browser-followup-runtime-missing" },
    );
  }
  log(
    `Continuing browser session (${runOptions.model}) with ~${promptArtifacts.estimatedInputTokens.toLocaleString()} tokens.`,
  );
  log(chalk.dim(`Reusing browser conversation from session ${parentSession.id}.`));
  const logger: BrowserLogger = ((message?: string) => {
    if (typeof message !== "string") return;
    const shouldAlwaysPrint = message.startsWith("[browser] ") && /fallback|retry/i.test(message);
    if (!runOptions.verbose && !shouldAlwaysPrint) return;
    log(message);
  }) as BrowserLogger;
  logger.verbose = Boolean(runOptions.verbose);
  logger.sessionLog = runOptions.verbose ? log : () => {};
  const startedAt = Date.now();
  let result;
  try {
    result = await continueBrowser(
      runtime,
      browserConfig,
      logger,
      {
        prompt: promptArtifacts.composerText,
        attachments: promptArtifacts.attachments,
        fallbackSubmission: promptArtifacts.fallback
          ? {
              prompt: promptArtifacts.fallback.composerText,
              attachments: promptArtifacts.fallback.attachments,
            }
          : undefined,
      },
      deps,
    );
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Browser follow-up automation failed.";
    throw new BrowserAutomationError(message, { stage: "continue-browser" }, error);
  }
  if (result.runtime) {
    await deps.persistRuntimeHint?.(result.runtime);
  }
  const outputTokens =
    result.answerTokens ?? estimateTokenCount(result.answerMarkdown || result.answerText || "");
  const elapsedMs = result.tookMs ?? Date.now() - startedAt;
  const usage = {
    inputTokens: promptArtifacts.estimatedInputTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: promptArtifacts.estimatedInputTokens + outputTokens,
  };
  if (!runOptions.silent) {
    log(chalk.bold("Answer:"));
    log(result.answerMarkdown || result.answerText || chalk.dim("(no text output)"));
    log("");
  }
  const tokensPart = [
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ]
    .map((value) => formatTokenCount(value))
    .join("/");
  const { line1, line2 } = formatFinishLine({
    elapsedMs,
    model: `${runOptions.model}[browser-followup]`,
    tokensPart: `↑${tokensPart.split("/")[0]} ↓${tokensPart.split("/")[1]} ↻${tokensPart.split("/")[2]} Δ${tokensPart.split("/")[3]}`,
    detailParts: [
      runOptions.file && runOptions.file.length > 0 ? `files=${runOptions.file.length}` : null,
      `followup=${parentSession.id}`,
    ],
  });
  log(chalk.blue(line1));
  if (line2) {
    log(chalk.dim(line2));
  }
  return {
    usage,
    elapsedMs,
    runtime: result.runtime ?? runtime,
    answerText: result.answerMarkdown || result.answerText || "",
  };
}
