import { EnvHttpProxyAgent, type Dispatcher } from "undici";

// Gemini's /app policy/reporting headers exceed Node's default 16 KiB limit.
const GEMINI_MAX_HEADER_SIZE = 64 * 1024;
let geminiDispatcher: Dispatcher | undefined;

export function createGeminiWebDispatcher(options: EnvHttpProxyAgent.Options = {}): Dispatcher {
  return new EnvHttpProxyAgent({ ...options, maxHeaderSize: GEMINI_MAX_HEADER_SIZE });
}

export async function fetchGeminiWebResource(
  url: string,
  init: RequestInit & { dispatcher?: Dispatcher } = {},
): Promise<Response> {
  try {
    const dispatcher = init.dispatcher ?? (geminiDispatcher ??= createGeminiWebDispatcher());
    const options = { ...init, dispatcher };
    return await fetch(url, options);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "UND_ERR_HEADERS_OVERFLOW"
    ) {
      throw new Error(
        "Gemini response headers exceed the HTTP transport's configured limit (Oracle's default is 64 KiB).",
        { cause: error },
      );
    }
    throw error;
  }
}
