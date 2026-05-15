import chalk from "chalk";
import kleur from "kleur";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import type {
  ClientLike,
  OracleResponse,
  ResponseStreamLike,
  RunOracleDeps,
  RunOracleOptions,
  RunOracleResult,
  ModelName,
} from "./types.js";
import { DEFAULT_SYSTEM_PROMPT, TOKENIZER_OPTIONS } from "./config.js";
import { readFiles } from "./files.js";
import { buildPrompt, buildRequestBody } from "./request.js";
import { estimateRequestTokens } from "./tokenEstimate.js";
import { formatElapsed } from "./format.js";
import { formatFinishLine } from "./finishLine.js";
import { getFileTokenStats, printFileTokenStats } from "./tokenStats.js";
import {
  OracleResponseError,
  OracleTransportError,
  PromptValidationError,
  describeTransportError,
  toTransportError,
} from "./errors.js";
import { createDefaultClientFactory, isCustomBaseUrl } from "./client.js";
import { formatBaseUrlForLog, maskApiKey } from "./logging.js";
import { startHeartbeat } from "../heartbeat.js";
import { startOscProgress } from "./oscProgress.js";
import { createFsAdapter } from "./fsAdapter.js";
import { resolveGeminiModelId } from "./gemini.js";
import { resolveClaudeModelId } from "./claude.js";
import { renderMarkdownAnsi } from "../cli/markdownRenderer.js";
import { createMarkdownStreamer } from "markdansi";
import { executeBackgroundResponse } from "./background.js";
import { formatTokenEstimate, formatTokenValue, resolvePreviewMode } from "./runUtils.js";
import { estimateUsdCost } from "tokentally";
import {
  defaultOpenRouterBaseUrl,
  isOpenRouterBaseUrl,
  isProModel,
  resolveModelConfig,
  normalizeOpenRouterBaseUrl,
} from "./modelResolver.js";
import { validateProviderRouting } from "./providerRouting.js";

type MarkdownStreamer = ReturnType<typeof createMarkdownStreamer>;

const isStdoutTty = process.stdout.isTTY && chalk.level > 0;
const dim = (text: string): string => (isStdoutTty ? kleur.dim(text) : text);
// Default timeout for non-pro API runs (fast models) — give them up to 120s.
const DEFAULT_TIMEOUT_NON_PRO_MS = 120_000;
const DEFAULT_TIMEOUT_PRO_MS = 60 * 60 * 1000;
const DEFAULT_PROVIDER_HOSTS: Record<string, string> = {
  anthropic: "api.anthropic.com",
  google: "generativelanguage.googleapis.com",
  openai: "api.openai.com",
  xai: "api.x.ai",
};

const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function formatRouteTargetForLog(raw: string | undefined, fallbackHost = ""): string {
  if (!raw) return fallbackHost;
  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname.split("/").filter(Boolean);
    let path = "";
    if (segments.length > 0) {
      path = `/${segments[0]}`;
      if (segments.length > 1) {
        path += "/...";
      }
    }
    return `${parsed.host}${path}`;
  } catch {
    const formatted = formatBaseUrlForLog(raw).replace(/^https?:\/\//u, "");
    return formatted || fallbackHost;
  }
}

function formatProviderRouteLogLine({
  provider,
  baseUrl,
  openRouterFallback,
  isAzureOpenAI,
  azureEndpoint,
  azureDeploymentName,
  envVar,
}: {
  provider: string;
  baseUrl?: string;
  openRouterFallback: boolean;
  isAzureOpenAI: boolean;
  azureEndpoint?: string;
  azureDeploymentName?: string;
  envVar: string;
}): string {
  if (isAzureOpenAI) {
    return `Provider: Azure OpenAI | endpoint: ${formatRouteTargetForLog(azureEndpoint)} | deployment: ${azureDeploymentName || "none"} | key: ${envVar}`;
  }

  const isOpenRouter = isOpenRouterBaseUrl(baseUrl) || openRouterFallback;
  const routeProvider = isOpenRouter
    ? "OpenRouter"
    : baseUrl && isCustomBaseUrl(baseUrl)
      ? "OpenAI-compatible"
      : provider === "anthropic"
        ? "Anthropic"
        : provider === "google"
          ? "Google Gemini"
          : provider === "xai"
            ? "xAI"
            : "OpenAI";
  const fallbackHost = DEFAULT_PROVIDER_HOSTS[provider] ?? DEFAULT_PROVIDER_HOSTS.openai;
  return `Provider: ${routeProvider} | base: ${formatRouteTargetForLog(baseUrl, fallbackHost)} | key: ${envVar}`;
}

export async function runOracle(
  options: RunOracleOptions,
  deps: RunOracleDeps = {},
): Promise<RunOracleResult> {
  const {
    apiKey: optionsApiKey = options.apiKey,
    cwd = process.cwd(),
    fs: fsModule = createFsAdapter(fs),
    log = console.log,
    write: sinkWrite = (_text: string) => true,
    allowStdout = true,
    stdoutWrite: stdoutWriteDep,
    now = () => performance.now(),
    clientFactory = createDefaultClientFactory(),
    client,
    wait = defaultWait,
  } = deps;
  const stdoutWrite = allowStdout
    ? (stdoutWriteDep ?? process.stdout.write.bind(process.stdout))
    : () => true;
  const isTty = allowStdout && isStdoutTty;
  const resolvedXaiBaseUrl = process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1";
  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  const defaultOpenRouterBase = defaultOpenRouterBaseUrl();
  const previewMode = resolvePreviewMode(options.previewMode ?? options.preview);
  const isPreview = Boolean(previewMode);

  const providerMode = options.provider ?? "auto";
  const routing = validateProviderRouting(
    {
      model: options.model,
      providerMode,
      azure: options.azure,
    },
    {
      onAzureDeploymentMissing: (state) => {
        if (!isPreview && !options.suppressHeader) {
          log(
            dim(
              `Provider: Azure OpenAI | endpoint: ${formatRouteTargetForLog(state.azureEndpoint)} | deployment: none | key: ${
                optionsApiKey ? "apiKey option" : "AZURE_OPENAI_API_KEY|OPENAI_API_KEY"
              }`,
            ),
          );
        }
      },
    },
  );
  const { provider, isAzureOpenAI, azureEndpoint, azureDeploymentName } = routing;

  const hasOpenAIKey =
    Boolean(optionsApiKey) ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(
      providerMode !== "openai" && process.env.AZURE_OPENAI_API_KEY && options.azure?.endpoint,
    );
  const hasAnthropicKey = Boolean(optionsApiKey) || Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGeminiKey = Boolean(optionsApiKey) || Boolean(process.env.GEMINI_API_KEY);
  const hasXaiKey = Boolean(optionsApiKey) || Boolean(process.env.XAI_API_KEY);

  let baseUrl = options.baseUrl?.trim();
  const providerQualifiedOpenRouterCandidate =
    !isAzureOpenAI && providerMode !== "openai" && options.model.includes("/");
  if (
    baseUrl &&
    providerQualifiedOpenRouterCandidate &&
    !isOpenRouterBaseUrl(baseUrl) &&
    !isCustomBaseUrl(baseUrl)
  ) {
    baseUrl = undefined;
  }
  if (!baseUrl) {
    let envBaseUrl: string | undefined;
    if (options.model.startsWith("grok")) {
      envBaseUrl = resolvedXaiBaseUrl;
    } else if (provider === "anthropic") {
      envBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
    } else {
      envBaseUrl = process.env.OPENAI_BASE_URL?.trim();
    }
    if (!providerQualifiedOpenRouterCandidate || (envBaseUrl && isCustomBaseUrl(envBaseUrl))) {
      baseUrl = envBaseUrl;
    }
  }
  const providerKeyMissing =
    !isAzureOpenAI &&
    (providerMode === "openai"
      ? !hasOpenAIKey
      : (provider === "openai" && !hasOpenAIKey) ||
        (provider === "anthropic" && !hasAnthropicKey) ||
        (provider === "google" && !hasGeminiKey) ||
        (provider === "xai" && !hasXaiKey) ||
        provider === "other");
  const providerQualifiedOpenRouterRoute = providerQualifiedOpenRouterCandidate && !baseUrl;
  const openRouterFallback =
    !baseUrl &&
    (providerQualifiedOpenRouterRoute ||
      (providerMode !== "openai" &&
        providerKeyMissing &&
        (provider === "other" || Boolean(openRouterApiKey))));
  if (!baseUrl || openRouterFallback) {
    if (openRouterFallback) {
      baseUrl = defaultOpenRouterBase;
    }
  }
  if (baseUrl && isOpenRouterBaseUrl(baseUrl)) {
    baseUrl = normalizeOpenRouterBaseUrl(baseUrl);
  }

  const logVerbose = (message: string): void => {
    if (options.verbose) {
      log(dim(`[verbose] ${message}`));
    }
  };

  const getApiKeyForModel = (model: ModelName): { key?: string; source: string } => {
    if (isAzureOpenAI) {
      if (optionsApiKey) return { key: optionsApiKey, source: "apiKey option" };
      const key = process.env.AZURE_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
      return { key, source: "AZURE_OPENAI_API_KEY|OPENAI_API_KEY" };
    }
    if (providerMode === "openai") {
      if (optionsApiKey) return { key: optionsApiKey, source: "apiKey option" };
      return { key: process.env.OPENAI_API_KEY, source: "OPENAI_API_KEY" };
    }
    if (isOpenRouterBaseUrl(baseUrl) || openRouterFallback) {
      return { key: optionsApiKey ?? openRouterApiKey, source: "OPENROUTER_API_KEY" };
    }
    if (typeof model === "string" && model.startsWith("gpt")) {
      if (optionsApiKey) return { key: optionsApiKey, source: "apiKey option" };
      return { key: process.env.OPENAI_API_KEY, source: "OPENAI_API_KEY" };
    }
    if (typeof model === "string" && model.startsWith("gemini")) {
      return { key: optionsApiKey ?? process.env.GEMINI_API_KEY, source: "GEMINI_API_KEY" };
    }
    if (typeof model === "string" && model.startsWith("claude")) {
      return { key: optionsApiKey ?? process.env.ANTHROPIC_API_KEY, source: "ANTHROPIC_API_KEY" };
    }
    if (typeof model === "string" && model.startsWith("grok")) {
      return { key: optionsApiKey ?? process.env.XAI_API_KEY, source: "XAI_API_KEY" };
    }
    return {
      key: optionsApiKey ?? openRouterApiKey,
      source: optionsApiKey ? "apiKey option" : "OPENROUTER_API_KEY",
    };
  };

  const apiKeyResult = getApiKeyForModel(options.model);
  const apiKey = apiKeyResult.key;
  if (!apiKey) {
    const envVar = isAzureOpenAI
      ? "AZURE_OPENAI_API_KEY (or OPENAI_API_KEY)"
      : providerMode === "openai"
        ? "OPENAI_API_KEY"
        : isOpenRouterBaseUrl(baseUrl) || openRouterFallback
          ? "OPENROUTER_API_KEY"
          : options.model.startsWith("gpt")
            ? "OPENAI_API_KEY"
            : options.model.startsWith("gemini")
              ? "GEMINI_API_KEY"
              : options.model.startsWith("claude")
                ? "ANTHROPIC_API_KEY"
                : options.model.startsWith("grok")
                  ? "XAI_API_KEY"
                  : "OPENROUTER_API_KEY";
    const browserModeHint = options.model.startsWith("gpt")
      ? ' If you have a ChatGPT Pro subscription, retry with --engine browser (or MCP engine:"browser" / preset:"chatgpt-pro-heavy"); browser mode uses your signed-in ChatGPT session instead of an API key.'
      : "";
    throw new PromptValidationError(
      `Missing ${envVar}. Set it via the environment or a .env file.${browserModeHint}`,
      {
        env: envVar,
      },
    );
  }

  const envVar = apiKeyResult.source;

  const minPromptLength = Number.parseInt(process.env.ORACLE_MIN_PROMPT_CHARS ?? "10", 10);
  const promptLength = options.prompt?.trim().length ?? 0;
  // Enforce the short-prompt guardrail on pro-tier models because they're costly; cheaper models can run short prompts without blocking.
  const isProTierModel = isProModel(options.model);
  if (isProTierModel && !Number.isNaN(minPromptLength) && promptLength < minPromptLength) {
    throw new PromptValidationError(
      `Prompt is too short (<${minPromptLength} chars). This was likely accidental; please provide more detail.`,
      { minPromptLength, promptLength },
    );
  }

  const resolverOpenRouterApiKey =
    openRouterFallback || isOpenRouterBaseUrl(baseUrl) ? (openRouterApiKey ?? apiKey) : undefined;
  const modelConfig = await resolveModelConfig(options.model, {
    baseUrl,
    openRouterApiKey: resolverOpenRouterApiKey,
  });
  const isLongRunningModel = isProTierModel;
  const supportsBackground = modelConfig.supportsBackground !== false;
  const useBackground = supportsBackground ? (options.background ?? isLongRunningModel) : false;

  const inputTokenBudget = options.maxInput ?? modelConfig.inputLimit;
  const files = await readFiles(options.file ?? [], {
    cwd,
    fsModule,
    maxFileSizeBytes: options.maxFileSizeBytes,
  });
  const searchEnabled = options.search !== false;
  logVerbose(`cwd: ${cwd}`);
  let pendingNoFilesTip: string | null = null;
  let pendingShortPromptTip: string | null = null;
  if (files.length > 0) {
    const displayPaths = files
      .map((file) => path.relative(cwd, file.path) || file.path)
      .slice(0, 10)
      .join(", ");
    const extra = files.length > 10 ? ` (+${files.length - 10} more)` : "";
    logVerbose(`Attached files (${files.length}): ${displayPaths}${extra}`);
  } else {
    logVerbose("No files attached.");
    if (!isPreview) {
      pendingNoFilesTip =
        "Tip: no files attached — Oracle works best with project context. Add files via --file path/to/code or docs.";
    }
  }
  const shortPrompt = (options.prompt?.trim().length ?? 0) < 80;
  if (!isPreview && shortPrompt) {
    pendingShortPromptTip =
      "Tip: brief prompts often yield generic answers — aim for 6–30 sentences and attach key files.";
  }
  const fileTokenInfo = getFileTokenStats(files, {
    cwd,
    tokenizer: modelConfig.tokenizer,
    tokenizerOptions: TOKENIZER_OPTIONS,
    inputTokenBudget,
  });
  const totalFileTokens = fileTokenInfo.totalTokens;
  logVerbose(`Attached files use ${totalFileTokens.toLocaleString()} tokens`);

  const systemPrompt = options.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const promptWithFiles = buildPrompt(options.prompt, files, cwd);
  const fileCount = files.length;
  const richTty = allowStdout && process.stdout.isTTY && chalk.level > 0;
  const renderPlain = Boolean(options.renderPlain);
  const timeoutSeconds =
    options.timeoutSeconds === undefined || options.timeoutSeconds === "auto"
      ? isLongRunningModel
        ? DEFAULT_TIMEOUT_PRO_MS / 1000
        : DEFAULT_TIMEOUT_NON_PRO_MS / 1000
      : options.timeoutSeconds;
  const timeoutMs = timeoutSeconds * 1000;
  const httpTimeoutMs =
    typeof options.httpTimeoutMs === "number" &&
    Number.isFinite(options.httpTimeoutMs) &&
    options.httpTimeoutMs > 0
      ? options.httpTimeoutMs
      : timeoutMs;
  // Track the concrete model id we dispatch to (especially for Gemini preview aliases)
  const effectiveModelId =
    azureDeploymentName ??
    options.effectiveModelId ??
    (options.model.startsWith("gemini")
      ? resolveGeminiModelId(options.model)
      : (modelConfig.apiModel ?? modelConfig.model));
  if (!isPreview && options.previousResponseId) {
    log(dim(`Continuing from response ${options.previousResponseId}`));
  }
  const requestBody = buildRequestBody({
    modelConfig,
    systemPrompt,
    userPrompt: promptWithFiles,
    searchEnabled,
    maxOutputTokens: options.maxOutput,
    background: useBackground,
    // Storing makes follow-ups possible (Responses API chaining relies on stored response state).
    storeResponse: useBackground || Boolean(options.previousResponseId),
    previousResponseId: options.previousResponseId,
  });
  requestBody.model = effectiveModelId;
  const estimatedInputTokens = estimateRequestTokens(requestBody, modelConfig);
  const tokenLabel = formatTokenEstimate(estimatedInputTokens, (text) =>
    richTty ? chalk.green(text) : text,
  );
  const fileLabel = richTty ? chalk.magenta(fileCount.toString()) : fileCount.toString();
  const filesPhrase = fileCount === 0 ? "no files" : `${fileLabel} files`;
  const headerModelLabelBase = richTty ? chalk.cyan(modelConfig.model) : modelConfig.model;
  const headerModelSuffix =
    effectiveModelId !== modelConfig.model
      ? richTty
        ? chalk.gray(` (API: ${effectiveModelId})`)
        : ` (API: ${effectiveModelId})`
      : "";
  const headerLine = `Calling ${headerModelLabelBase}${headerModelSuffix} — ${tokenLabel} tokens, ${filesPhrase}.`;
  const shouldReportFiles =
    (options.filesReport || fileTokenInfo.totalTokens > inputTokenBudget) &&
    fileTokenInfo.stats.length > 0;
  if (!isPreview) {
    if (!options.suppressHeader) {
      log(headerLine);
      log(
        dim(
          formatProviderRouteLogLine({
            provider,
            baseUrl,
            openRouterFallback,
            isAzureOpenAI,
            azureEndpoint,
            azureDeploymentName,
            envVar,
          }),
        ),
      );
    }
    const maskedKey = maskApiKey(apiKey);
    if (maskedKey && options.verbose) {
      const resolvedSuffix =
        effectiveModelId !== modelConfig.model ? ` (API: ${effectiveModelId})` : "";
      log(dim(`Using ${envVar}=${maskedKey} for model ${modelConfig.model}${resolvedSuffix}`));
    }
    if (
      !options.suppressHeader &&
      (modelConfig.model === "gpt-5.1-pro" || modelConfig.model === "gpt-5.2-pro") &&
      effectiveModelId === "gpt-5.5-pro"
    ) {
      log(
        dim(
          `Note: \`${modelConfig.model}\` is a stable CLI alias; OpenAI API uses \`gpt-5.5-pro\`.`,
        ),
      );
    }
    if (effectiveModelId !== modelConfig.model) {
      log(dim(`Resolved model: ${modelConfig.model} → ${effectiveModelId}`));
    }
    if (options.background && !supportsBackground) {
      log(
        dim("Background runs are not supported for this model; streaming in foreground instead."),
      );
    }
    if (!options.suppressTips) {
      if (pendingNoFilesTip) {
        log(dim(pendingNoFilesTip));
      }
      if (pendingShortPromptTip) {
        log(dim(pendingShortPromptTip));
      }
    }
    if (isLongRunningModel) {
      log(dim("This model can take up to 60 minutes (usually replies much faster)."));
    }
    if (options.verbose || isLongRunningModel || httpTimeoutMs < timeoutMs) {
      const timeoutLine = `Timeouts | overall: ${formatElapsed(timeoutMs)} | transport: ${formatElapsed(httpTimeoutMs)}`;
      const timeoutNote =
        httpTimeoutMs < timeoutMs ? " | note: transport can fail before overall timeout" : "";
      log(dim(`${timeoutLine}${timeoutNote}`));
    }
    if (options.verbose || isLongRunningModel) {
      log(dim("Press Ctrl+C to cancel."));
    }
  }
  if (shouldReportFiles) {
    printFileTokenStats(fileTokenInfo, { inputTokenBudget, log });
  }
  if (estimatedInputTokens > inputTokenBudget) {
    throw new PromptValidationError(
      `Input too large (${estimatedInputTokens.toLocaleString()} tokens). Limit is ${inputTokenBudget.toLocaleString()} tokens.`,
      { estimatedInputTokens, inputTokenBudget },
    );
  }

  logVerbose(`Estimated tokens (request body): ${estimatedInputTokens.toLocaleString()}`);

  if (isPreview && previewMode) {
    if (previewMode === "json" || previewMode === "full") {
      log("Request JSON");
      log(JSON.stringify(requestBody, null, 2));
      log("");
    }
    if (previewMode === "full") {
      log("Assembled Prompt");
      log(promptWithFiles);
      log("");
    }
    log(
      `Estimated input tokens: ${estimatedInputTokens.toLocaleString()} / ${inputTokenBudget.toLocaleString()} (model: ${modelConfig.model})`,
    );
    return {
      mode: "preview",
      previewMode,
      requestBody,
      estimatedInputTokens,
      inputTokenBudget,
    };
  }

  const proxyCompatibleBaseUrl =
    !isAzureOpenAI && baseUrl && (isOpenRouterBaseUrl(baseUrl) || isCustomBaseUrl(baseUrl))
      ? baseUrl
      : undefined;
  const apiEndpoint = isAzureOpenAI
    ? undefined
    : modelConfig.model.startsWith("gemini")
      ? proxyCompatibleBaseUrl
      : proxyCompatibleBaseUrl
        ? proxyCompatibleBaseUrl
        : modelConfig.model.startsWith("claude")
          ? (process.env.ANTHROPIC_BASE_URL ?? baseUrl)
          : baseUrl;
  const clientInstance: ClientLike =
    client ??
    clientFactory(apiKey, {
      baseUrl: apiEndpoint,
      azure: isAzureOpenAI ? options.azure : undefined,
      model: options.model,
      resolvedModelId: modelConfig.model.startsWith("claude")
        ? resolveClaudeModelId(effectiveModelId)
        : modelConfig.model.startsWith("gemini")
          ? resolveGeminiModelId(effectiveModelId as ModelName)
          : effectiveModelId,
      httpTimeoutMs,
    });
  logVerbose("Dispatching request to API...");
  if (options.verbose) {
    log(""); // ensure verbose section is separated from Answer stream
  }
  const stopOscProgress = startOscProgress({
    label: useBackground ? "Waiting for API (background)" : "Waiting for API",
    targetMs: useBackground ? timeoutMs : Math.min(timeoutMs, 10 * 60_000),
    indeterminate: true,
    write: sinkWrite,
  });

  const runStart = now();
  let response: OracleResponse | null = null;
  let elapsedMs = 0;
  let sawTextDelta = false;
  let answerHeaderPrinted = false;
  const allowAnswerHeader = options.suppressAnswerHeader !== true;
  const timeoutExceeded = (): boolean => now() - runStart >= timeoutMs;
  const throwIfTimedOut = () => {
    if (timeoutExceeded()) {
      throw new OracleTransportError(
        "client-timeout",
        `Timed out waiting for API response after ${formatElapsed(timeoutMs)}.`,
      );
    }
  };
  const ensureAnswerHeader = () => {
    if (options.silent || answerHeaderPrinted) return;
    // Always add a separating newline for readability; optionally include the label depending on caller needs.
    log("");
    if (allowAnswerHeader) {
      log(chalk.bold("Answer:"));
    }
    answerHeaderPrinted = true;
  };

  try {
    if (useBackground) {
      response = await executeBackgroundResponse({
        client: clientInstance,
        requestBody,
        log,
        wait,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        now,
        maxWaitMs: timeoutMs,
      });
      elapsedMs = now() - runStart;
    } else {
      let stream: ResponseStreamLike;
      try {
        stream = await clientInstance.responses.stream(requestBody);
      } catch (streamInitError) {
        const transportError = toTransportError(streamInitError, requestBody.model);
        log(chalk.yellow(describeTransportError(transportError, timeoutMs)));
        throw transportError;
      }
      let heartbeatActive = false;
      let stopHeartbeat: (() => void) | null = null;
      const stopHeartbeatNow = () => {
        if (!heartbeatActive) {
          return;
        }
        heartbeatActive = false;
        stopHeartbeat?.();
        stopHeartbeat = null;
      };
      if (options.heartbeatIntervalMs && options.heartbeatIntervalMs > 0) {
        heartbeatActive = true;
        stopHeartbeat = startHeartbeat({
          intervalMs: options.heartbeatIntervalMs,
          log: (message) => log(message),
          isActive: () => heartbeatActive,
          makeMessage: (elapsedMs) => {
            const elapsedText = formatElapsed(elapsedMs);
            const remainingMs = Math.max(timeoutMs - elapsedMs, 0);
            const remainingLabel =
              remainingMs >= 60_000
                ? `${Math.ceil(remainingMs / 60_000)} min`
                : `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
            return `API connection active — ${elapsedText} elapsed. Timeout in ~${remainingLabel} if no response.`;
          },
        });
      }
      let markdownStreamer: MarkdownStreamer | null = null;
      const flushMarkdownStreamer = () => {
        if (!markdownStreamer) return;
        const rendered = markdownStreamer.finish();
        markdownStreamer = null;
        if (rendered) {
          stdoutWrite(rendered);
        }
      };
      try {
        markdownStreamer =
          isTty && !renderPlain
            ? createMarkdownStreamer({
                render: renderMarkdownAnsi,
                spacing: "single",
                mode: "hybrid",
              })
            : null;

        for await (const event of stream) {
          throwIfTimedOut();
          const isTextDelta = event.type === "chunk" || event.type === "response.output_text.delta";
          if (!isTextDelta) continue;

          stopOscProgress();
          stopHeartbeatNow();
          sawTextDelta = true;
          ensureAnswerHeader();
          if (options.silent || typeof event.delta !== "string") continue;

          // Always keep the log/bookkeeping sink up to date.
          sinkWrite(event.delta);
          if (renderPlain) {
            // Plain mode: stream directly to stdout regardless of write sink.
            stdoutWrite(event.delta);
            continue;
          }

          if (markdownStreamer) {
            const rendered = markdownStreamer.push(event.delta);
            if (rendered) {
              stdoutWrite(rendered);
            }
            continue;
          }

          // Non-TTY streams should still surface output; fall back to raw stdout.
          stdoutWrite(event.delta);
        }

        flushMarkdownStreamer();
        throwIfTimedOut();
      } catch (streamError) {
        // stream.abort() is not available on the interface
        flushMarkdownStreamer();
        stopHeartbeatNow();
        const transportError = toTransportError(streamError, requestBody.model);
        log(chalk.yellow(describeTransportError(transportError, timeoutMs)));
        throw transportError;
      }
      response = await stream.finalResponse();
      throwIfTimedOut();
      stopHeartbeatNow();
      elapsedMs = now() - runStart;
    }
  } finally {
    stopOscProgress();
  }

  if (!response) {
    throw new Error("API did not return a response.");
  }

  // We only add spacing when streamed text was printed.
  if (sawTextDelta && !options.silent) {
    if (renderPlain) {
      // Plain streaming already wrote chunks; ensure clean separation.
      stdoutWrite("\n");
    } else {
      // Separate streamed output from logs.
      log("");
    }
  }

  logVerbose(`Response status: ${response.status ?? "completed"}`);

  if (response.status && response.status !== "completed") {
    // API can reply `in_progress` even after the stream closes; give it a brief grace poll.
    if (response.id && response.status === "in_progress") {
      const polishingStart = now();
      const pollIntervalMs = 2_000;
      const maxWaitMs = 180_000;
      log(chalk.dim("Response still in_progress; polling until completion..."));
      // Short polling loop — we don't want to hang forever, just catch late finalization.
      while (now() - polishingStart < maxWaitMs) {
        throwIfTimedOut();
        await wait(pollIntervalMs);
        const refreshed = await clientInstance.responses.retrieve(response.id);
        if (refreshed.status === "completed") {
          response = refreshed;
          break;
        }
      }
    }

    if (response.status !== "completed") {
      const detail =
        response.error?.message || response.incomplete_details?.reason || response.status;
      log(
        chalk.yellow(
          `API ended the run early (status=${response.status}${response.incomplete_details?.reason ? `, reason=${response.incomplete_details.reason}` : ""}).`,
        ),
      );
      throw new OracleResponseError(`Response did not complete: ${detail}`, response);
    }
  }

  const answerText = extractTextOutput(response);
  if (!options.silent) {
    // Flag flips to true when streaming events arrive.
    if (sawTextDelta) {
      // Already handled above (rendered or streamed); avoid double-printing.
    } else {
      ensureAnswerHeader();
      // Render markdown to ANSI in rich TTYs unless the caller opts out with --render-plain.
      const printable = answerText
        ? renderPlain || !richTty
          ? answerText
          : renderMarkdownAnsi(answerText)
        : chalk.dim("(no text output)");
      sinkWrite(printable);
      if (!printable.endsWith("\n")) {
        sinkWrite("\n");
      }
      stdoutWrite(printable);
      if (!printable.endsWith("\n")) {
        stdoutWrite("\n");
      }
      log("");
    }
  }

  const usage = response.usage ?? {};
  const inputTokens = usage.input_tokens ?? estimatedInputTokens;
  const outputTokens = usage.output_tokens ?? 0;
  const reasoningTokens = usage.reasoning_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens + reasoningTokens;
  const pricing = modelConfig.pricing ?? undefined;
  const cost = pricing
    ? estimateUsdCost({
        usage: { inputTokens, outputTokens, reasoningTokens, totalTokens },
        pricing: {
          inputUsdPerToken: pricing.inputPerToken,
          outputUsdPerToken: pricing.outputPerToken,
        },
      })?.totalUsd
    : undefined;

  const effortLabel = modelConfig.reasoning?.effort;
  const modelLabel = effortLabel ? `${modelConfig.model}[${effortLabel}]` : modelConfig.model;
  const sessionIdContainsModel =
    typeof options.sessionId === "string" &&
    options.sessionId.toLowerCase().includes(modelConfig.model.toLowerCase());
  const tokensDisplay = [inputTokens, outputTokens, reasoningTokens, totalTokens]
    .map((value, index) => formatTokenValue(value, usage, index))
    .join("/");
  const tokensPart = (() => {
    const parts = tokensDisplay.split("/");
    if (parts.length !== 4) return tokensDisplay;
    return `↑${parts[0]} ↓${parts[1]} ↻${parts[2]} Δ${parts[3]}`;
  })();

  const modelPart = sessionIdContainsModel ? null : modelLabel;
  const actualInput = usage.input_tokens;
  const estActualPart = (() => {
    if (!options.verbose) return null;
    if (actualInput === undefined) return null;
    const delta = actualInput - estimatedInputTokens;
    const deltaText =
      delta === 0
        ? ""
        : delta > 0
          ? ` (+${delta.toLocaleString()})`
          : ` (${delta.toLocaleString()})`;
    return `est→actual=${estimatedInputTokens.toLocaleString()}→${actualInput.toLocaleString()}${deltaText}`;
  })();

  const { line1, line2 } = formatFinishLine({
    elapsedMs,
    model: modelPart,
    costUsd: cost ?? null,
    tokensPart,
    summaryExtraParts: options.sessionId ? [`sid=${options.sessionId}`] : null,
    detailParts: [
      estActualPart,
      !searchEnabled ? "search=off" : null,
      files.length > 0 ? `files=${files.length}` : null,
    ],
  });

  if (!options.silent) {
    log("");
  }
  log(chalk.blue(line1));
  if (line2) {
    log(dim(line2));
  }

  return {
    mode: "live",
    response,
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      ...(cost != null ? { cost } : {}),
    },
    elapsedMs,
  };
}

export function extractTextOutput(response: OracleResponse): string {
  if (Array.isArray(response.output_text) && response.output_text.length > 0) {
    return response.output_text.join("\n");
  }
  if (Array.isArray(response.output)) {
    const segments: string[] = [];
    for (const item of response.output) {
      if (Array.isArray(item.content)) {
        for (const chunk of item.content) {
          if (chunk && (chunk.type === "output_text" || chunk.type === "text") && chunk.text) {
            segments.push(chunk.text);
          }
        }
      } else if (typeof item.text === "string") {
        segments.push(item.text);
      }
    }
    return segments.join("\n");
  }
  return "";
}
