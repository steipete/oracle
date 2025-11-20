import OpenAI, { AzureOpenAI } from 'openai';
import path from 'node:path';
import { createRequire } from 'node:module';
import type {
  AzureOptions,
  ClientFactory,
  ClientLike,
  OracleRequestBody,
  OracleResponse,
  ResponseStreamLike,
  ModelName,
} from './types.js';
import { createGeminiClient } from './gemini.js';
import { createClaudeClient } from './claude.js';

const CUSTOM_CLIENT_FACTORY = loadCustomClientFactory();

export function createDefaultClientFactory(): ClientFactory {
  if (CUSTOM_CLIENT_FACTORY) {
    return CUSTOM_CLIENT_FACTORY;
  }
  return (
    key: string,
    options?: { baseUrl?: string; azure?: AzureOptions; model?: ModelName; resolvedModelId?: string },
  ): ClientLike => {
    if (options?.model?.startsWith('gemini')) {
      // Gemini client uses its own SDK; allow passing the already-resolved id for transparency/logging.
      return createGeminiClient(key, options.model, options.resolvedModelId);
    }
    if (options?.model?.startsWith('claude')) {
      return createClaudeClient(key, options.model, options.resolvedModelId, options.baseUrl);
    }

    let instance: OpenAI;

    if (options?.azure?.endpoint) {
      instance = new AzureOpenAI({
        apiKey: key,
        endpoint: options.azure.endpoint,
        apiVersion: options.azure.apiVersion,
        deployment: options.azure.deployment,
        timeout: 20 * 60 * 1000,
      });
    } else {
      instance = new OpenAI({
        apiKey: key,
        timeout: 20 * 60 * 1000,
        baseURL: options?.baseUrl,
      });
    }

    return {
      responses: {
        stream: (body: OracleRequestBody) =>
          instance.responses.stream(body) as unknown as Promise<ResponseStreamLike>,
        create: (body: OracleRequestBody) =>
          instance.responses.create(body) as unknown as Promise<OracleResponse>,
        retrieve: (id: string) => instance.responses.retrieve(id) as unknown as Promise<OracleResponse>,
      },
    };
  };
}

function loadCustomClientFactory(): ClientFactory | null {
  const override = process.env.ORACLE_CLIENT_FACTORY;
  if (!override) {
    return null;
  }
  try {
    const require = createRequire(import.meta.url);
    const resolved = path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
    const moduleExports = require(resolved);
    const factory =
      typeof moduleExports === 'function'
        ? moduleExports
        : typeof moduleExports?.default === 'function'
          ? moduleExports.default
          : typeof moduleExports?.createClientFactory === 'function'
            ? moduleExports.createClientFactory
            : null;
    if (typeof factory === 'function') {
      return factory as ClientFactory;
    }
    console.warn(`Custom client factory at ${resolved} did not export a function.`);
  } catch (error) {
    console.warn(`Failed to load ORACLE_CLIENT_FACTORY module "${override}":`, error);
  }
  return null;
}
