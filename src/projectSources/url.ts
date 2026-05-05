export function normalizeProjectSourcesUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(
      `Invalid ChatGPT project URL: ${rawUrl} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "chatgpt.com" && hostname !== "chat.openai.com") {
    throw new Error(`Project Sources require a ChatGPT URL, received: ${rawUrl}`);
  }
  if (!/\/project\/?$/u.test(url.pathname)) {
    throw new Error(
      `Project Sources require a ChatGPT project URL ending in /project, received: ${rawUrl}`,
    );
  }
  const existingParams = Array.from(url.searchParams.entries()).filter(([key]) => key !== "tab");
  url.search = "";
  url.searchParams.set("tab", "sources");
  for (const [key, value] of existingParams) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}
