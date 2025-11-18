export type TokenizerFn = (input: unknown, options?: Record<string, unknown>) => number;

export type ModelName = 'gpt-5-pro' | 'gpt-5.1';

export interface ModelConfig {
  model: ModelName;
  tokenizer: TokenizerFn;
  inputLimit: number;
  pricing: {
    inputPerToken: number;
    outputPerToken: number;
  };
  reasoning: { effort: 'high' } | null;
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
  abort?: () => void;
}

export interface ClientLike {
  responses: {
    stream(body: OracleRequestBody): Promise<ResponseStreamLike> | ResponseStreamLike;
    create(body: OracleRequestBody): Promise<OracleResponse>;
    retrieve(id: string): Promise<OracleResponse>;
  };
}

export type ClientFactory = (apiKey: string, options?: { baseUrl?: string }) => ClientLike;

export interface RunOracleOptions {
  prompt: string;
  model: ModelName;
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
  sessionId?: string;
  verbose?: boolean;
  heartbeatIntervalMs?: number;
  browserInlineFiles?: boolean;
  browserBundleFiles?: boolean;
  background?: boolean;
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
  type: 'web_search_preview';
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
  reasoning?: { effort: 'high' };
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

export type TransportFailureReason = 'client-timeout' | 'connection-lost' | 'client-abort' | 'unknown';
