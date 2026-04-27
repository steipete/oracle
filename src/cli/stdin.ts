export async function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: string[] = [];
  if (typeof (stream as { setEncoding?: (encoding: string) => void }).setEncoding === "function") {
    (stream as { setEncoding: (encoding: string) => void }).setEncoding("utf8");
  }
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
  }
  return chunks.join("");
}

export async function resolveDashPrompt(
  prompt: string | undefined,
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string | undefined> {
  if (prompt !== "-") {
    return prompt;
  }
  if ((stream as NodeJS.ReadStream).isTTY) {
    throw new Error(`"-p -" requires piped input (for example: echo "prompt" | oracle -p -).`);
  }
  const stdinPrompt = (await readStdin(stream)).trim();
  if (!stdinPrompt) {
    throw new Error(`"-p -" received empty stdin.`);
  }
  return stdinPrompt;
}
