import { MODEL_CONFIGS } from "./config.js";
import { PromptValidationError } from "./errors.js";
import { isKnownModel } from "./modelResolver.js";
import type { ApiProviderMode, AzureOptions, ModelConfig, ModelName } from "./types.js";

export const AZURE_DEPLOYMENT_REQUIRED_MESSAGE =
  "Azure mode requires --azure-deployment unless your deployment is literally gpt-5.5-pro. Pass --azure-deployment <deployment> (or set AZURE_OPENAI_DEPLOYMENT), or rerun with --provider openai/--no-azure to use api.openai.com.";

export interface ProviderRoutingState {
  knownModelConfig?: ModelConfig;
  provider: NonNullable<ModelConfig["provider"]>;
  providerMode: ApiProviderMode;
  azureEndpoint?: string;
  azureDeploymentOption?: string;
  isNonOpenAIModel: boolean;
  isAzureOpenAI: boolean;
  azureDeploymentName?: string;
}

export interface ProviderRoutingInput {
  model: ModelName;
  providerMode?: ApiProviderMode;
  azure?: AzureOptions;
}

export function resolveProviderRoutingState({
  model,
  providerMode = "auto",
  azure,
}: ProviderRoutingInput): ProviderRoutingState {
  const knownModelConfig = isKnownModel(model) ? MODEL_CONFIGS[model] : undefined;
  const provider = knownModelConfig?.provider ?? inferNativeProviderFromModelId(model) ?? "other";
  const azureEndpoint = azure?.endpoint?.trim();
  const azureDeploymentOption = azure?.deployment?.trim();
  const isNonOpenAIModel = provider !== "openai" && provider !== "other";
  const isProviderQualifiedModelId = model.includes("/");

  if (providerMode === "azure" && !azureEndpoint) {
    throw new PromptValidationError(
      "--provider azure requires --azure-endpoint or AZURE_OPENAI_ENDPOINT.",
      {
        provider: "azure",
        endpoint: "none",
      },
    );
  }
  if (providerMode === "azure" && isNonOpenAIModel) {
    throw new PromptValidationError(
      `Azure OpenAI provider cannot run ${model}. Choose an OpenAI/Azure deployment model, or rerun without --provider azure for the model's native provider.`,
      {
        provider: "azure",
        model,
        modelProvider: provider,
      },
    );
  }
  if (providerMode === "openai" && isNonOpenAIModel) {
    throw new PromptValidationError(
      `OpenAI provider cannot run ${model}. Choose an OpenAI model, or rerun without --provider openai/--no-azure for the model's native provider.`,
      {
        provider: "openai",
        model,
        modelProvider: provider,
      },
    );
  }

  const isOpenAIFamilyModel = provider === "openai" || model.startsWith("gpt");
  const isCustomAzureModelId = provider === "other" && !model.includes("/");
  const isAzureOpenAI = Boolean(
    azureEndpoint &&
    providerMode !== "openai" &&
    !isNonOpenAIModel &&
    (providerMode === "azure" ||
      (!isProviderQualifiedModelId &&
        (isOpenAIFamilyModel || Boolean(azureDeploymentOption) || isCustomAzureModelId))),
  );
  const implicitAzureDeploymentName =
    isAzureOpenAI &&
    !azureDeploymentOption &&
    (knownModelConfig?.apiModel ?? knownModelConfig?.model) === "gpt-5.5-pro"
      ? "gpt-5.5-pro"
      : undefined;

  return {
    knownModelConfig,
    provider,
    providerMode,
    azureEndpoint,
    azureDeploymentOption,
    isNonOpenAIModel,
    isAzureOpenAI,
    azureDeploymentName: azureDeploymentOption ?? implicitAzureDeploymentName,
  };
}

function inferNativeProviderFromModelId(model: ModelName): ModelConfig["provider"] | undefined {
  const providerPrefix = model.includes("/") ? model.split("/", 1)[0] : undefined;
  if (providerPrefix === "openai") return "openai";
  if (providerPrefix === "anthropic") return "anthropic";
  if (providerPrefix === "google") return "google";
  if (providerPrefix === "xai") return "xai";
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gemini")) return "google";
  if (model.startsWith("grok")) return "xai";
  return undefined;
}

export function isAzureOpenAICandidateModel(model: ModelName): boolean {
  const knownModelConfig = isKnownModel(model) ? MODEL_CONFIGS[model] : undefined;
  const provider = knownModelConfig?.provider ?? inferNativeProviderFromModelId(model) ?? "other";
  return (
    provider === "openai" ||
    model.startsWith("gpt") ||
    (provider === "other" && !model.includes("/"))
  );
}

export function validateProviderRouting(
  input: ProviderRoutingInput,
  hooks: {
    onAzureDeploymentMissing?: (state: ProviderRoutingState) => void;
  } = {},
): ProviderRoutingState {
  const state = resolveProviderRoutingState(input);
  if (state.isAzureOpenAI && !state.azureDeploymentName) {
    hooks.onAzureDeploymentMissing?.(state);
    throw new PromptValidationError(AZURE_DEPLOYMENT_REQUIRED_MESSAGE, {
      provider: "azure",
      endpoint: state.azureEndpoint ?? "none",
      deployment: "none",
    });
  }
  return state;
}
