import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const codeToTokens = vi.fn();
const createHighlighter = vi.fn().mockResolvedValue({
  getLoadedLanguages: () => ["ts", "swift", "js", "jsx", "tsx", "json"],
  codeToTokens,
});

vi.mock("shiki", () => ({
  __esModule: true,
  createHighlighter,
  bundledThemes: { "github-dark": {} },
  bundledLanguages: {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    json: "json",
    swift: "swift",
  },
}));

const stdoutProperties = ["isTTY", "columns"] as const;
const originalDescriptors = Object.getOwnPropertyDescriptors(process.stdout);

beforeEach(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
  codeToTokens.mockReset();
});

afterEach(() => {
  for (const property of stdoutProperties) {
    const descriptor = originalDescriptors[property];
    if (descriptor) {
      Object.defineProperty(process.stdout, property, descriptor);
    } else {
      delete process.stdout[property];
    }
  }
});

describe("renderMarkdownAnsi", () => {
  test("invokes highlighter for supported fenced code blocks", async () => {
    codeToTokens.mockReturnValue({
      tokens: [
        [
          { content: "let", color: "#ff0000", fontStyle: 0 },
          { content: " ", color: undefined, fontStyle: 0 },
          { content: "x", color: "#00ff00", fontStyle: 0 },
        ],
      ],
    });

    const { renderMarkdownAnsi } = await import("../../src/cli/markdownRenderer.ts");
    const { ensureShikiReady } = await import("../../src/cli/markdownRenderer.ts");
    await ensureShikiReady();

    const out = renderMarkdownAnsi("```ts\nlet x\n```");
    expect(out).toContain("let x");
  });

  test("skips highlighter for unsupported languages", async () => {
    const { renderMarkdownAnsi } = await import("../../src/cli/markdownRenderer.ts");
    await Promise.resolve();

    renderMarkdownAnsi("```bash\necho hi\n```");
    expect(codeToTokens).not.toHaveBeenCalled();
  });
});
