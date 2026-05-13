import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type {
  BuildRequestBodyParams,
  FileContent,
  MinimalFsModule,
  ModelConfig,
  OracleRequestBody,
  RunOracleOptions,
  ToolConfig,
} from "./types.js";
import { DEFAULT_SYSTEM_PROMPT } from "./config.js";
import { createFileSections, readFiles } from "./files.js";
import { formatFileSection } from "./markdown.js";
import { createFsAdapter } from "./fsAdapter.js";
import {
  attachPromptTransportMetadata,
  type PromptTransportInputHash,
  type PromptTransportMetadata,
  type PromptTransportMetadataOptions,
  type PromptTransportProviderFamily,
  type PromptTransportRedactionDecision,
  type PromptTransportRequestedMode,
} from "../types/transport.js";

type BuildRequestBodyWithTransportParams = BuildRequestBodyParams & {
  transport?: PromptTransportMetadataOptions;
};

const PROMPT_TRANSPORT_POLICY = {
  schema_version: "oracle.prompt_transport.v1",
  prompt_semantics: "unchanged",
  prompt_text_in_metadata: "sha256_hash_only",
  untrusted_source_instructions: "user_data_only",
};

const DEFAULT_REDACTION_DECISIONS: PromptTransportRedactionDecision[] = [
  "raw_prompt_omitted",
  "raw_output_omitted",
  "raw_dom_omitted",
  "cookies_omitted",
  "screenshots_omitted",
  "hidden_reasoning_omitted",
  "input_hashes_only",
  "untrusted_source_instructions_are_user_data",
];

export function buildPrompt(basePrompt: string, files: FileContent[], cwd = process.cwd()): string {
  if (!files.length) {
    return basePrompt;
  }
  const sections = createFileSections(files, cwd);
  const sectionText = sections.map((section) => section.sectionText).join("\n\n");
  if (!basePrompt) {
    return sectionText;
  }
  const separator = basePrompt.endsWith("\n") ? "\n" : "\n\n";
  return `${basePrompt}${separator}${sectionText}`;
}

export function buildRequestBody({
  modelConfig,
  systemPrompt,
  userPrompt,
  searchEnabled,
  maxOutputTokens,
  background,
  storeResponse,
  previousResponseId,
  transport,
}: BuildRequestBodyWithTransportParams): OracleRequestBody {
  const searchToolType: ToolConfig["type"] = modelConfig.searchToolType ?? "web_search_preview";
  const requestBody: OracleRequestBody = {
    model: modelConfig.apiModel ?? modelConfig.model,
    previous_response_id: previousResponseId ? previousResponseId : undefined,
    instructions: systemPrompt,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: userPrompt,
          },
        ],
      },
    ],
    tools: searchEnabled ? [{ type: searchToolType }] : undefined,
    reasoning: modelConfig.reasoning || undefined,
    max_output_tokens: maxOutputTokens,
    background: background ? true : undefined,
    store: storeResponse ? true : undefined,
  };
  return attachPromptTransportMetadata(
    requestBody,
    createPromptTransportMetadata({
      modelConfig,
      systemPrompt,
      userPrompt,
      searchEnabled,
      maxOutputTokens,
      background,
      storeResponse,
      previousResponseId,
      transport,
    }),
  );
}

export function createPromptTransportMetadata({
  modelConfig,
  systemPrompt,
  userPrompt,
  searchEnabled,
  maxOutputTokens,
  background,
  storeResponse,
  previousResponseId,
  transport,
}: {
  modelConfig: ModelConfig;
  systemPrompt: string;
  userPrompt: string;
  searchEnabled: boolean;
  maxOutputTokens?: number;
  background?: boolean;
  storeResponse?: boolean;
  previousResponseId?: string;
  transport?: PromptTransportMetadataOptions;
}): PromptTransportMetadata {
  const requestedMode = transport?.requestedMode ?? "api";
  const tokenBudget = transport?.tokenBudget ?? maxOutputTokens;
  return {
    schema_version: "oracle.prompt_transport.v1",
    provider_family: transport?.providerFamily ?? inferProviderFamily(modelConfig),
    provider_slot:
      transport?.providerSlot ??
      modelConfig.openRouterId ??
      modelConfig.apiModel ??
      modelConfig.model,
    requested_mode: requestedMode,
    policy_family: "oracle.prompt_transport",
    policy_version: "v1",
    prompt_semantics: "unchanged",
    evidence_policy: transport?.evidencePolicy ?? "metadata-only",
    included_sections:
      transport?.includedSections ??
      defaultIncludedSections({
        requestedMode,
        searchEnabled,
        maxOutputTokens,
        background,
        storeResponse,
        previousResponseId,
      }),
    excluded_sections:
      transport?.excludedSections ??
      defaultExcludedSections({ searchEnabled, background, storeResponse, previousResponseId }),
    input_hashes: [
      createInputHash("system_prompt", systemPrompt),
      createInputHash("user_prompt", userPrompt),
    ],
    context_serialization_policy_hash:
      transport?.contextSerializationPolicyHash ??
      createInputHash("context_serialization_policy", stableJson(PROMPT_TRANSPORT_POLICY)),
    redaction_decisions: uniqueRedactionDecisions([
      ...DEFAULT_REDACTION_DECISIONS,
      ...(transport?.redactionDecisions ?? []),
    ]),
    transport_settings: {
      search_enabled: searchEnabled,
      background: Boolean(background),
      store_response: Boolean(storeResponse),
      previous_response_id: Boolean(previousResponseId),
      ...(transport?.transportSettings ?? {}),
    },
    ...(typeof tokenBudget === "number" ? { token_budget: tokenBudget } : {}),
  };
}

export async function renderPromptMarkdown(
  options: Pick<RunOracleOptions, "prompt" | "file" | "system" | "maxFileSizeBytes">,
  deps: { cwd?: string; fs?: MinimalFsModule } = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const fsModule = deps.fs ?? createFsAdapter(fs);
  const files = await readFiles(options.file ?? [], {
    cwd,
    fsModule,
    maxFileSizeBytes: options.maxFileSizeBytes,
  });
  const sections = createFileSections(files, cwd);
  const systemPrompt = options.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const userPrompt = (options.prompt ?? "").trim();
  const lines = ["[SYSTEM]", systemPrompt, ""];
  lines.push("[USER]", userPrompt, "");
  sections.forEach((section) => {
    lines.push(formatFileSection(section.displayPath, section.content));
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function createInputHash(source: PromptTransportInputHash["source"], input: string) {
  return {
    source,
    algorithm: "sha256" as const,
    value: createHash("sha256").update(input, "utf8").digest("hex"),
  };
}

function inferProviderFamily(modelConfig: ModelConfig): PromptTransportProviderFamily {
  if (modelConfig.provider) return modelConfig.provider;
  const modelName =
    `${modelConfig.openRouterId ?? modelConfig.apiModel ?? modelConfig.model}`.toLowerCase();
  if (modelName.startsWith("gpt-") || modelName.includes("openai/")) return "openai";
  if (modelName.startsWith("claude") || modelName.includes("anthropic/")) return "anthropic";
  if (modelName.startsWith("gemini") || modelName.includes("google/")) return "google";
  if (modelName.startsWith("grok") || modelName.includes("x-ai/")) return "xai";
  return "other";
}

function defaultIncludedSections({
  requestedMode,
  searchEnabled,
  maxOutputTokens,
  background,
  storeResponse,
  previousResponseId,
}: {
  requestedMode: PromptTransportRequestedMode;
  searchEnabled: boolean;
  maxOutputTokens?: number;
  background?: boolean;
  storeResponse?: boolean;
  previousResponseId?: string;
}) {
  const sections = [`transport.${requestedMode}`, "instructions", "input.user_text"];
  if (searchEnabled) sections.push("tools.web_search");
  if (typeof maxOutputTokens === "number") sections.push("max_output_tokens");
  if (background) sections.push("background");
  if (storeResponse) sections.push("store");
  if (previousResponseId) sections.push("previous_response_id");
  return sections;
}

function defaultExcludedSections({
  searchEnabled,
  background,
  storeResponse,
  previousResponseId,
}: {
  searchEnabled: boolean;
  background?: boolean;
  storeResponse?: boolean;
  previousResponseId?: string;
}) {
  const sections = ["developer_message", "browser_dom", "cookies", "raw_prompt_text"];
  if (!searchEnabled) sections.push("tools.web_search");
  if (!background) sections.push("background");
  if (!storeResponse) sections.push("store");
  if (!previousResponseId) sections.push("previous_response_id");
  return sections;
}

function uniqueRedactionDecisions(decisions: PromptTransportRedactionDecision[]) {
  return Array.from(new Set(decisions));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
