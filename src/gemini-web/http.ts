export async function fetchGeminiWebResource(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "UND_ERR_HEADERS_OVERFLOW"
    ) {
      throw new Error(
        "Gemini response headers exceed Node's configured limit. Start Oracle with NODE_OPTIONS=--max-http-header-size=65536 (preserving any existing Node options) and retry.",
        { cause: error },
      );
    }
    throw error;
  }
}
