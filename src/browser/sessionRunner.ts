import chalk from "chalk";
import type { RunOracleOptions } from "../oracle.js";
import { formatTokenCount } from "../oracle/runUtils.js";
import { formatFinishLine } from "../oracle/finishLine.js";
import type {
  BrowserModelSelectionEvidence,
  BrowserRunWarning,
  BrowserSessionConfig,
  BrowserRuntimeMetadata,
  SessionArtifact,
} from "../sessionStore.js";
import { runBrowserMode } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import { assembleBrowserPrompt } from "./prompt.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserArchiveResult, BrowserLogger } from "./types.js";
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "./artifacts.js";

export interface BrowserExecutionResult {
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  elapsedMs: number;
  runtime: BrowserRuntimeMetadata;
  archive?: BrowserArchiveResult;
  modelSelection?: BrowserModelSelectionEvidence;
  warnings?: BrowserRunWarning[];
  answerText: string;
  artifacts?: SessionArtifact[];
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
  persistRuntimeHint?: (runtime: BrowserRuntimeMetadata) => Promise<void> | void;
}

const LARGE_PRO_FAST_INPUT_TOKEN_THRESHOLD = 25_000;
const LARGE_PRO_FAST_ELAPSED_MS_THRESHOLD = 120_000;

function buildUnavailableModelSelectionEvidence(
  browserConfig: BrowserSessionConfig,
): BrowserModelSelectionEvidence | undefined {
  if (!browserConfig.desiredModel) {
    return undefined;
  }
  return {
    requestedModel: browserConfig.desiredModel,
    resolvedLabel: null,
    strategy: browserConfig.modelStrategy,
    status: "unavailable",
    verified: false,
    source: "config",
    capturedAt: new Date().toISOString(),
  };
}

function formatModelSelectionEvidence(evidence: BrowserModelSelectionEvidence): string {
  const requested = evidence.requestedModel ?? "(none)";
  const resolved = evidence.resolvedLabel ?? "(unavailable)";
  const strategy = evidence.strategy ?? "(default)";
  const verified = evidence.verified ? "yes" : "no";
  return `[browser] Model selection evidence: requested=${requested}; resolved=${resolved}; status=${evidence.status}; strategy=${strategy}; verified=${verified}.`;
}

function isRequestedProBrowserRun(
  runOptions: RunOracleOptions,
  browserConfig: BrowserSessionConfig,
  evidence?: BrowserModelSelectionEvidence,
): boolean {
  const candidates = [
    runOptions.model,
    browserConfig.desiredModel,
    evidence?.requestedModel,
    evidence?.resolvedLabel,
  ];
  return candidates.some((value) => typeof value === "string" && /\bpro\b/i.test(value));
}

export function buildBrowserRunWarningsForTest(args: {
  runOptions: RunOracleOptions;
  browserConfig: BrowserSessionConfig;
  inputTokens: number;
  elapsedMs: number;
  modelSelection?: BrowserModelSelectionEvidence;
}): BrowserRunWarning[] {
  return buildBrowserRunWarnings(args);
}

function buildBrowserRunWarnings(args: {
  runOptions: RunOracleOptions;
  browserConfig: BrowserSessionConfig;
  inputTokens: number;
  elapsedMs: number;
  modelSelection?: BrowserModelSelectionEvidence;
}): BrowserRunWarning[] {
  if (
    !isRequestedProBrowserRun(args.runOptions, args.browserConfig, args.modelSelection) ||
    args.inputTokens < LARGE_PRO_FAST_INPUT_TOKEN_THRESHOLD ||
    args.elapsedMs >= LARGE_PRO_FAST_ELAPSED_MS_THRESHOLD
  ) {
    return [];
  }
  return [
    {
      code: "browser-pro-fast-large-run",
      severity: "warning",
      message: `Large browser Pro run completed quickly (${(args.elapsedMs / 1000).toFixed(0)}s for ~${args.inputTokens.toLocaleString()} input tokens); verify the stored model selection evidence before claiming Pro Extended output.`,
      details: {
        inputTokens: args.inputTokens,
        elapsedMs: args.elapsedMs,
        requestedModel: args.modelSelection?.requestedModel ?? args.browserConfig.desiredModel,
        resolvedLabel: args.modelSelection?.resolvedLabel ?? null,
      },
    },
  ];
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
    const shouldAlwaysPrint =
      message.startsWith("[browser] ") &&
      /archive|fallback|follow-up|retry|thinking|waiting for chatgpt|browser slot|browser control|browser guidance|model selection|model picker/i.test(
        message,
      );
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
      sessionId: runOptions.sessionId,
      generateImagePath: runOptions.generateImage,
      outputPath: runOptions.outputPath,
      followUpPrompts: runOptions.browserFollowUps,
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
  const modelSelection =
    browserResult.modelSelection ?? buildUnavailableModelSelectionEvidence(browserConfig);
  if (modelSelection) {
    log(formatModelSelectionEvidence(modelSelection));
  }
  const warnings = buildBrowserRunWarnings({
    runOptions,
    browserConfig,
    inputTokens: promptArtifacts.estimatedInputTokens,
    elapsedMs: browserResult.tookMs,
    modelSelection,
  });
  for (const warning of warnings) {
    log(chalk.yellow(`[browser] ${warning.message}`));
  }
  if (!runOptions.silent) {
    log(chalk.bold("Answer:"));
    log(browserResult.answerMarkdown || browserResult.answerText || chalk.dim("(no text output)"));
    log("");
  }
  const answerText = browserResult.answerMarkdown || browserResult.answerText || "";
  const savedArtifacts = await ensureSessionArtifacts({
    sessionId: runOptions.sessionId,
    prompt: promptArtifacts.composerText,
    answerMarkdown: answerText,
    conversationUrl: browserResult.tabUrl,
    browserConfig,
    existingArtifacts: browserResult.artifacts,
    logger: automationLogger,
  });
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
      browserTransport: browserResult.browserTransport,
      chromePid: browserResult.chromePid,
      chromePort: browserResult.chromePort,
      chromeHost: browserResult.chromeHost,
      chromeBrowserWSEndpoint: browserResult.chromeBrowserWSEndpoint,
      chromeProfileRoot: browserResult.chromeProfileRoot,
      userDataDir: browserResult.userDataDir,
      chromeTargetId: browserResult.chromeTargetId,
      tabUrl: browserResult.tabUrl,
      conversationId: browserResult.conversationId,
      promptSubmitted: browserResult.promptSubmitted,
      controllerPid: browserResult.controllerPid ?? process.pid,
    },
    archive: browserResult.archive,
    modelSelection,
    warnings,
    answerText,
    artifacts: savedArtifacts,
  };
}

export async function ensureSessionArtifacts(params: {
  sessionId?: string;
  prompt: string;
  answerMarkdown: string;
  conversationUrl?: string;
  browserConfig: BrowserSessionConfig;
  existingArtifacts?: SessionArtifact[];
  logger: BrowserLogger;
}): Promise<SessionArtifact[] | undefined> {
  if (!params.sessionId || !params.answerMarkdown.trim()) {
    return params.existingArtifacts;
  }
  let artifacts = params.existingArtifacts;
  const hasReport = artifacts?.some((artifact) => artifact.kind === "deep-research-report");
  if (params.browserConfig.researchMode === "deep" && !hasReport) {
    const report = await saveDeepResearchReportArtifact({
      sessionId: params.sessionId,
      reportMarkdown: params.answerMarkdown,
      conversationUrl: params.conversationUrl,
      logger: params.logger,
    }).catch(() => null);
    artifacts = appendArtifacts(artifacts, [report]);
  }
  const hasTranscript = artifacts?.some((artifact) => artifact.kind === "transcript");
  if (!hasTranscript) {
    const transcript = await saveBrowserTranscriptArtifact({
      sessionId: params.sessionId,
      prompt: params.prompt,
      answerMarkdown: params.answerMarkdown,
      conversationUrl: params.conversationUrl,
      artifacts,
      logger: params.logger,
    }).catch(() => null);
    artifacts = appendArtifacts(artifacts, [transcript]);
  }
  return artifacts;
}
