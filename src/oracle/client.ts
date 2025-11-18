import OpenAI from 'openai';
import path from 'node:path';
import { createRequire } from 'node:module';
import type {
  ClientFactory,
  ClientLike,
  OracleRequestBody,
  OracleResponse,
  ResponseStreamLike,
} from './types.js';

const CUSTOM_CLIENT_FACTORY = loadCustomClientFactory();

export function createDefaultClientFactory(): ClientFactory {
  if (CUSTOM_CLIENT_FACTORY) {
    return CUSTOM_CLIENT_FACTORY;
  }
  return (key: string, options?: { baseUrl?: string }): ClientLike => {
    const instance = new OpenAI({
      apiKey: key,
      timeout: 20 * 60 * 1000,
      baseURL: options?.baseUrl,
    });
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
