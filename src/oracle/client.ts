import OpenAI from 'openai';
import type { ClientLike, OracleRequestBody, OracleResponse, ResponseStreamLike } from './types.js';

export function createDefaultClientFactory(): (apiKey: string) => ClientLike {
  return (key: string): ClientLike => {
    const instance = new OpenAI({
      apiKey: key,
      timeout: 20 * 60 * 1000,
    });
    return {
      responses: {
        stream: (body: OracleRequestBody) =>
          instance.responses.stream(body) as unknown as Promise<ResponseStreamLike>,
        create: (body: OracleRequestBody) => instance.responses.create(body) as Promise<OracleResponse>,
        retrieve: (id: string) => instance.responses.retrieve(id) as Promise<OracleResponse>,
      },
    };
  };
}
