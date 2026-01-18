export type TokenizerFn = (input: unknown, options?: Record<string, unknown>) => number;

export type KnownModelName =
  | 'gpt-5.1-pro'
  | 'gpt-5-pro'
  | 'gpt-5.1'
  | 'gpt-5.1-codex'
  | 'gpt-5.2'
  | 'gpt-5.2-instant'
  | 'gpt-5.2-pro'
  | 'gemini-3-pro'
  | 'claude-4.5-sonnet'
  | 'claude-4.1-opus'
  | 'grok-4.1';

// ModelName now allows arbitrary strings so OpenRouter / custom IDs can pass through.
export type ModelName = KnownModelName | (string & {});

export type ProModelName = 'gpt-5.1-pro' | 'gpt-5-pro' | 'gpt-5.2-pro' | 'claude-4.5-sonnet' | 'claude-4.1-opus';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type ThinkingTimeLevel = 'light' | 'standard' | 'extended' | 'heavy';

export interface AzureOptions {
  endpoint?: string;
  apiVersion?: string;
  deployment?: string;
}

export type ClientFactory = (
  apiKey: string,
  options?: {
    baseUrl?: string;
    azure?: AzureOptions;
    model?: ModelName;
    resolvedModelId?: string;
    httpTimeoutMs?: number;
  },
) => ClientLike;

export interface ModelConfig {
  model: ModelName;
  /** Provider-specific model id used for API calls (defaults to `model`). */
  apiModel?: string;
  /** Upstream provider to help with OpenRouter mapping and auth precedence. */
  provider?: 'openai' | 'anthropic' | 'google' | 'xai' | 'other';
  /** Explicit OpenRouter model id when it differs from apiModel/model. */
  openRouterId?: string;
  tokenizer: TokenizerFn;
  inputLimit: number;
  pricing?: {
    inputPerToken: number;
    outputPerToken: number;
  } | null;
  reasoning: { effort: ReasoningEffort } | null;
  supportsBackground?: boolean;
  supportsSearch?: boolean;
  searchToolType?: ToolConfig['type'];
}

export interface FileContent {
  path: string;
  content: string;
}

export interface FileSection {
  index: number;
  absolutePath: string;
  displayPath: string;
  sectionText: string;
  content: string;
}

export interface FsStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size?: number;
}

export interface MinimalFsModule {
  stat(targetPath: string): Promise<FsStats>;
  readdir(targetPath: string): Promise<string[]>;
  readFile(targetPath: string, encoding: NodeJS.BufferEncoding): Promise<string>;
}

export interface FileTokenEntry {
  path: string;
  displayPath: string;
  tokens: number;
  percent?: number;
}

export interface FileTokenStats {
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
}

export interface ClientLike {
  responses: {
    stream(body: OracleRequestBody): Promise<ResponseStreamLike> | ResponseStreamLike;
    create(body: OracleRequestBody): Promise<OracleResponse>;
    retrieve(id: string): Promise<OracleResponse>;
  };
}

export interface RunOracleOptions {
  prompt: string;
  model: ModelName;
  models?: ModelName[];
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
  baseUrl?: string;
  azure?: AzureOptions;
  sessionId?: string;
  effectiveModelId?: string;
  verbose?: boolean;
  heartbeatIntervalMs?: number;
  /**
   * Browser-only: controls whether `--file` inputs are pasted inline (never upload),
   * uploaded as attachments (always), or selected automatically based on prompt size.
   */
  browserAttachments?: 'auto' | 'never' | 'always';
  browserInlineFiles?: boolean;
  browserBundleFiles?: boolean;
  background?: boolean;
  /** Optional absolute path to save only the assistant's final text output. */
  writeOutputPath?: string;
  /** Number of seconds to wait before timing out, or 'auto' to use model defaults. */
  timeoutSeconds?: number | 'auto';
  /** Override HTTP client timeout (milliseconds). */
  httpTimeoutMs?: number;
  /** Override zombie timeout for the session (milliseconds). */
  zombieTimeoutMs?: number;
  /** Use last log activity to detect stale sessions. */
  zombieUseLastActivity?: boolean;
  /** Render plain text instead of ANSI-rendered markdown when printing answers to a rich TTY. */
  renderPlain?: boolean;
  /** Suppress the per-run header log line (used for multi-model logs where a model header is already printed). */
  suppressHeader?: boolean;
  /** Hide the default “Answer:” label, but keep the leading newline for readability. */
  suppressAnswerHeader?: boolean;
  /** Skip preamble tips (no-files / short prompt) when a higher-level runner already printed them. */
  suppressTips?: boolean;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost?: number;
}

export interface PreviewResult {
  mode: 'preview';
  previewMode: PreviewMode;
  requestBody: OracleRequestBody;
  estimatedInputTokens: number;
  inputTokenBudget: number;
}

export interface LiveResult {
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
  allowStdout?: boolean;
  stdoutWrite?: (text: string) => boolean;
  now?: () => number;
  clientFactory?: ClientFactory;
  client?: ClientLike;
  wait?: (ms: number) => Promise<void>;
}

export interface BuildRequestBodyParams {
  modelConfig: ModelConfig;
  systemPrompt: string;
  userPrompt: string;
  searchEnabled: boolean;
  maxOutputTokens?: number;
  background?: boolean;
  storeResponse?: boolean;
}

export interface ToolConfig {
  type: 'web_search_preview' | 'web_search';
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
  reasoning?: { effort: ReasoningEffort };
  max_output_tokens?: number;
  background?: boolean;
  store?: boolean;
}

export interface ResponseContentPart {
  type?: string;
  text?: string;
}

export interface ResponseOutputItem {
  type?: string;
  content?: ResponseContentPart[];
  text?: string;
}

export interface OracleResponse {
  id?: string;
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
  // biome-ignore lint/style/useNamingConvention: field name provided by OpenAI Responses API
  _request_id?: string | null;
}

export interface OracleResponseMetadata {
  responseId?: string;
  requestId?: string | null;
  status?: string;
  incompleteReason?: string | null;
}

export type TransportFailureReason =
  | 'client-timeout'
  | 'connection-lost'
  | 'client-abort'
  | 'api-error'
  | 'model-unavailable'
  | 'unsupported-endpoint'
  | 'unknown';
