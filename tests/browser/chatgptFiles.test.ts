import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  collectChatGptFileArtifacts,
  readAssistantDownloadableFiles,
  saveAssistantDownloadButtonArtifacts,
  saveChatGptDownloadableFiles,
  __test__,
} from "../../src/browser/chatgptFiles.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

class FakeElement {
  clickCount = 0;

  constructor(
    public textContent = "",
    public attributes: Record<string, string> = {},
    public className = "",
    public children: FakeElement[] = [],
  ) {}

  click(): void {
    this.clickCount += 1;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  querySelector(): FakeElement | null {
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === "button" ? this.children : [];
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

function assistantTurn(buttons: FakeElement[]): FakeElement {
  return new FakeElement("", { "data-turn": "assistant" }, "", buttons);
}

function behaviorButton(text: string, attributes: Record<string, string> = {}): FakeElement {
  return new FakeElement(text, attributes, "behavior-btn");
}

function evaluateClickExpression(expression: string, turns: FakeElement[]): unknown[] {
  const document = { querySelectorAll: () => turns };
  return Function(
    "document",
    "HTMLElement",
    `return ${expression};`,
  )(document, FakeElement) as unknown[];
}

describe("readAssistantDownloadableFiles", () => {
  test("keeps ChatGPT file downloads and sandbox references but rejects external links", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://evil.example/archive.zip",
              filename: "archive.zip",
            },
            {
              url: "https://chatgpt.com/backend-api/me",
              downloadUrl: "https://chatgpt.com/backend-api/me",
              filename: "not-a-file.json",
            },
            {
              url: "https://chatgpt.com/backend-api/files/file_package/download",
              downloadUrl: "https://chatgpt.com/backend-api/files/file_package/download",
              sandboxUrl: "sandbox:/mnt/data/package.zip",
              filename: "package.zip",
              label: "package.zip",
            },
            {
              url: "sandbox:/mnt/data/source.tar.gz",
              sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
              filename: "source.tar.gz",
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const files = await readAssistantDownloadableFiles(runtime);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      url: "https://chatgpt.com/backend-api/files/file_package/download",
      sandboxUrl: "sandbox:/mnt/data/package.zip",
      filename: "package.zip",
    });
    expect(files[1]).toMatchObject({
      url: "sandbox:/mnt/data/source.tar.gz",
      sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
      filename: "source.tar.gz",
    });
  });
});

describe("saveChatGptDownloadableFiles", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    setOracleHomeDirOverrideForTest(null);
  });

  test("saves ChatGPT downloadable files as session artifacts with cookies", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-files-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/files/file_package/download?token=ok",
      headers: {
        get: (name: string) => {
          if (name === "content-type") return "application/zip";
          if (name === "content-disposition") return 'attachment; filename="package.zip"';
          return null;
        },
      },
      arrayBuffer: async () => Uint8Array.from([9, 8, 7]).buffer,
    } as unknown as Response);

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "https://chatgpt.com/backend-api/files/file_package/download",
          downloadUrl: "https://chatgpt.com/backend-api/files/file_package/download",
          sandboxUrl: "sandbox:/mnt/data/package.zip",
          filename: "ignored.bin",
          label: "package.zip",
        },
      ],
    });

    expect(result.saved).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]).toMatchObject({
      kind: "file",
      label: "package.zip",
      mimeType: "application/zip",
      sourceUrl: "sandbox:/mnt/data/package.zip",
      sandboxUrl: "sandbox:/mnt/data/package.zip",
      filename: "package.zip",
    });
    expect(result.savedFiles[0]?.path).toBe(
      path.join(tmpHome, "sessions", "file-session", "artifacts", "package.zip"),
    );
    await expect(fs.readFile(result.savedFiles[0]!.path)).resolves.toEqual(Buffer.from([9, 8, 7]));
  });

  test("saves sandbox-only references through the ChatGPT sandbox download endpoint", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-sandbox-file-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Fsource.tar.gz",
      headers: {
        get: (name: string) => {
          if (name === "content-type") return "application/gzip";
          if (name === "content-disposition") return 'attachment; filename="source.tar.gz"';
          return null;
        },
      },
      arrayBuffer: async () => Uint8Array.from([3, 2, 1]).buffer,
    } as Response);

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "sandbox:/mnt/data/source.tar.gz",
          sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
          filename: "source.tar.gz",
        },
      ],
    });

    expect(result.saved).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.savedFiles[0]).toMatchObject({
      kind: "file",
      filename: "source.tar.gz",
      sourceUrl: "sandbox:/mnt/data/source.tar.gz",
      sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
    });
    expect(result.savedFiles[0]?.path).toBe(
      path.join(tmpHome, "sessions", "file-session", "artifacts", "source.tar.gz"),
    );
    const [fetchUrl, fetchOptions] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(fetchUrl)).toBe(
      "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Fsource.tar.gz",
    );
    expect(fetchOptions).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: "__Secure-next-auth.session-token=abc",
        }),
      }),
    );
  });

  test("does not forward ChatGPT cookies across external redirects", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-redirect-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        statusText: "Found",
        url: "https://chatgpt.com/backend-api/files/file_csv/download",
        headers: {
          get: (name: string) =>
            name === "location" ? "https://cdn.example.com/generated/report.csv" : null,
        },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://cdn.example.com/generated/report.csv",
        headers: { get: () => null },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      } as unknown as Response);

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "https://chatgpt.com/backend-api/files/file_csv/download",
          downloadUrl: "https://chatgpt.com/backend-api/files/file_csv/download",
          filename: "report.csv",
        },
      ],
    });

    expect(result.savedFiles).toHaveLength(1);
    const firstHeaders = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const secondHeaders = vi.mocked(globalThis.fetch).mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(firstHeaders.cookie).toBe("__Secure-next-auth.session-token=abc");
    expect(secondHeaders.cookie).toBeUndefined();
  });

  test("does not fetch unsafe sandbox paths", async () => {
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn();

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "sandbox:/mnt/data/../secret.txt",
          sandboxUrl: "sandbox:/mnt/data/../secret.txt",
          filename: "secret.txt",
        },
      ],
    });

    expect(result.saved).toBe(false);
    expect(result.fileCount).toBe(1);
    expect(result.errors[0]).toContain("no ChatGPT download URL found");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("collectChatGptFileArtifacts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    setOracleHomeDirOverrideForTest(null);
  });

  test("discovers and saves downloadable file artifacts for a browser session", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-collect-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://chatgpt.com/backend-api/files/file_wheel/download",
              downloadUrl: "https://chatgpt.com/backend-api/files/file_wheel/download",
              sandboxUrl: "sandbox:/mnt/data/pkg.whl",
              filename: "pkg.whl",
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/files/file_wheel/download",
      headers: {
        get: (name: string) => (name === "content-type" ? "application/octet-stream" : null),
      },
      arrayBuffer: async () => Uint8Array.from([1, 3, 5]).buffer,
    } as unknown as Response);

    const result = await collectChatGptFileArtifacts({
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
    });

    expect(result.fileCount).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]?.path).toBe(
      path.join(tmpHome, "sessions", "collect-session", "artifacts", "pkg.whl"),
    );
  });

  test("does not poll download buttons when no file candidates are found", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: [] },
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({ cookies: [] }),
    } as unknown as ChromeClient["Network"];
    const page = {
      setDownloadBehavior: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient["Page"];
    const logger = vi.fn();

    const result = await collectChatGptFileArtifacts({
      Page: page,
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
      answerText: "Plain answer with no downloadable files.",
      logger,
    });

    expect(result).toEqual({ files: [], savedFiles: [], fileCount: 0 });
    expect(page.setDownloadBehavior).not.toHaveBeenCalled();
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
    expect(logger).not.toHaveBeenCalledWith(
      expect.stringContaining("Auto-save for downloadable files failed"),
    );
  });

  test("discovers sandbox links from captured answer markdown when DOM anchors are absent", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-text-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const csv = "name,value\nalpha,1\nbeta,2\n";
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: [] } })
        .mockResolvedValueOnce({
          result: {
            value: {
              ok: true,
              status: 200,
              statusText: "OK",
              url: "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Foracle_pr245_file_artifact_smoke.csv",
              contentDisposition: null,
              contentType: "text/csv",
              base64: Buffer.from(csv).toString("base64"),
            },
          },
        }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn();

    const result = await collectChatGptFileArtifacts({
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
      answerText:
        "CHECK_FILE_ARTIFACT_OK — [oracle_pr245_file_artifact_smoke.csv](sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv)",
    });

    expect(result.fileCount).toBe(1);
    expect(result.files[0]).toMatchObject({
      sandboxUrl: "sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv",
      filename: "oracle_pr245_file_artifact_smoke.csv",
    });
    expect(result.savedFiles[0]).toMatchObject({
      kind: "file",
      filename: "oracle_pr245_file_artifact_smoke.csv",
      sourceUrl: "sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv",
      mimeType: "text/csv",
    });
    expect(result.savedFiles[0]?.path).toBe(
      path.join(
        tmpHome,
        "sessions",
        "collect-session",
        "artifacts",
        "oracle_pr245_file_artifact_smoke.csv",
      ),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(runtime.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        awaitPromise: true,
        returnByValue: true,
      }),
    );
  });

  test("falls back to assistant download buttons when sandbox download URL is not fetchable", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-button-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    const filename = "oracle_pr245_file_artifact_smoke_out.csv";
    const csv = "name,value\nalpha,1\nbeta,2\n";
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: [] } })
        .mockResolvedValueOnce({
          result: {
            value: {
              ok: false,
              status: 404,
              statusText: "Not Found",
              url: "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Foracle_pr245_file_artifact_smoke_out.csv",
              contentDisposition: null,
              contentType: "application/json",
              base64: Buffer.from('{"detail":"Not Found"}').toString("base64"),
            },
          },
        })
        .mockImplementationOnce(async ({ expression }: { expression?: string }) => {
          const fallbackExpression = String(expression ?? "");
          if (!fallbackExpression.includes("const ALLOW_GENERIC_DOWNLOAD_LABELS = true")) {
            return { result: { value: [] } };
          }
          await fs.mkdir(artifactsDir, { recursive: true });
          await fs.writeFile(path.join(artifactsDir, filename), csv, "utf8");
          return {
            result: {
              value: [
                {
                  text: "Download",
                  ariaLabel: "",
                  testId: "download-files-turn-action-button",
                },
              ],
            },
          };
        }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    const page = {
      setDownloadBehavior: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient["Page"];

    const result = await collectChatGptFileArtifacts({
      Page: page,
      Runtime: runtime,
      Network: network,
      sessionId,
      answerText:
        "CHECK_FILE_ARTIFACT_OK [download](sandbox:/mnt/data/oracle_pr245_file_artifact_smoke_out.csv)",
    });

    expect(result.fileCount).toBe(1);
    expect(result.savedFiles[0]).toMatchObject({
      kind: "file",
      filename,
      label: filename,
      mimeType: "text/csv",
      path: path.join(artifactsDir, filename),
    });
    expect(page.setDownloadBehavior).toHaveBeenCalledWith({
      behavior: "allow",
      downloadPath: artifactsDir,
    });
    const fallbackExpression = String(vi.mocked(runtime.evaluate).mock.calls[2]?.[0]?.expression);
    expect(fallbackExpression).toContain("const ALLOW_GENERIC_DOWNLOAD_LABELS = true");
    expect(fallbackExpression).toContain("const MAX_CLICKS = 1");
    expect(fallbackExpression).toContain("download-files-turn-action-button");
  });

  test("clicks multiple assistant download buttons sequentially", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-sequential-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    const runtime = {
      evaluate: vi.fn().mockImplementation(async ({ expression }: { expression?: string }) => {
        const clicked: Array<{ text: string; ariaLabel: string; testId: string }> = [];
        const writes: string[] = [];
        const text = String(expression ?? "");
        const hasA = text.includes('"a.txt"');
        const hasB = text.includes('"b.md"');
        const hasC = text.includes('"c.zip"');
        await fs.mkdir(artifactsDir, { recursive: true });
        if (hasA && hasB && hasC) {
          writes.push("A.txt", "C.zip");
          clicked.push(
            { text: "Download A.txt", ariaLabel: "", testId: "" },
            { text: "Download B.md", ariaLabel: "", testId: "" },
            { text: "Download C.zip", ariaLabel: "", testId: "" },
          );
        } else if (hasA) {
          writes.push("A(1).txt");
          clicked.push({ text: "Download A.txt", ariaLabel: "", testId: "" });
        } else if (hasB) {
          writes.push("B(1).md");
          clicked.push({ text: "Download B.md", ariaLabel: "", testId: "" });
        } else if (hasC) {
          writes.push("C(1).zip");
          clicked.push({ text: "Download C.zip", ariaLabel: "", testId: "" });
        }
        await Promise.all(
          writes.map((filename) => fs.writeFile(path.join(artifactsDir, filename), filename)),
        );
        return { result: { value: clicked } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const page = {
      setDownloadBehavior: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient["Page"];

    const savedFiles = await saveAssistantDownloadButtonArtifacts({
      Page: page,
      Runtime: runtime,
      sessionId,
      files: [
        {
          url: "sandbox:/mnt/data/A.txt",
          sandboxUrl: "sandbox:/mnt/data/A.txt",
          filename: "A.txt",
        },
        { url: "sandbox:/mnt/data/B.md", sandboxUrl: "sandbox:/mnt/data/B.md", filename: "B.md" },
        {
          url: "sandbox:/mnt/data/C.zip",
          sandboxUrl: "sandbox:/mnt/data/C.zip",
          filename: "C.zip",
        },
      ],
    });

    expect(savedFiles.map((file) => file.filename).sort()).toEqual(["A.txt", "B.md", "C.zip"]);
    expect(runtime.evaluate).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(runtime.evaluate).mock.calls) {
      const expression = String(call[0]?.expression ?? "");
      expect(expression).not.toContain('"a.txt","b.md","c.zip"');
    }
  });

  test("preserves a browser-provided filename for a generic download endpoint", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-filename-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    const runtime = {
      evaluate: vi.fn().mockImplementation(async () => {
        await fs.mkdir(artifactsDir, { recursive: true });
        await fs.writeFile(path.join(artifactsDir, "report.csv"), "a,b\n1,2\n", "utf8");
        return { result: { value: [{ text: "Download", ariaLabel: "", testId: "" }] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const page = {
      setDownloadBehavior: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient["Page"];

    const savedFiles = await saveAssistantDownloadButtonArtifacts({
      Page: page,
      Runtime: runtime,
      sessionId,
      downloadWaitMs: 25,
      files: [
        {
          url: "https://chatgpt.com/backend-api/files/file_csv/download",
          downloadUrl: "https://chatgpt.com/backend-api/files/file_csv/download",
        },
      ],
    });

    expect(savedFiles).toHaveLength(1);
    expect(savedFiles[0]).toMatchObject({
      filename: "report.csv",
      label: "report.csv",
      mimeType: "text/csv",
    });
    await expect(fs.readFile(path.join(artifactsDir, "report.csv"), "utf8")).resolves.toBe(
      "a,b\n1,2\n",
    );
    await expect(fs.stat(path.join(artifactsDir, "download"))).rejects.toThrow();
  });

  test("stops after a timed-out download so a late completion cannot become the next file", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-missing-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    const logger = vi.fn();
    let lateCompletion: Promise<void> | undefined;
    const runtime = {
      evaluate: vi.fn().mockImplementation(async ({ expression }: { expression?: string }) => {
        const text = String(expression ?? "");
        await fs.mkdir(artifactsDir, { recursive: true });
        if (text.includes('"a.txt"')) {
          await fs.writeFile(path.join(artifactsDir, "A(1).txt"), "A");
          return { result: { value: [{ text: "Download A.txt", ariaLabel: "", testId: "" }] } };
        }
        if (text.includes('"b.md"')) {
          const partialPath = path.join(artifactsDir, "B.md.crdownload");
          await fs.writeFile(partialPath, "B");
          lateCompletion = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              void fs.rename(partialPath, path.join(artifactsDir, "B.md")).then(resolve, reject);
            }, 275);
          });
          return { result: { value: [{ text: "Download B.md", ariaLabel: "", testId: "" }] } };
        }
        if (text.includes('"c.zip"')) {
          return { result: { value: [{ text: "Download C.zip", ariaLabel: "", testId: "" }] } };
        }
        return { result: { value: [] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const page = {
      setDownloadBehavior: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient["Page"];

    const savedFiles = await saveAssistantDownloadButtonArtifacts({
      Page: page,
      Runtime: runtime,
      logger,
      sessionId,
      downloadWaitMs: 25,
      files: [
        {
          url: "sandbox:/mnt/data/A.txt",
          sandboxUrl: "sandbox:/mnt/data/A.txt",
          filename: "A.txt",
        },
        { url: "sandbox:/mnt/data/B.md", sandboxUrl: "sandbox:/mnt/data/B.md", filename: "B.md" },
        {
          url: "sandbox:/mnt/data/C.zip",
          sandboxUrl: "sandbox:/mnt/data/C.zip",
          filename: "C.zip",
        },
      ],
    });

    await lateCompletion;
    expect(savedFiles.map((file) => file.filename)).toEqual(["A.txt"]);
    expect(
      vi
        .mocked(runtime.evaluate)
        .mock.calls.some(([options]) => String(options?.expression ?? "").includes('"c.zip"')),
    ).toBe(false);
    await expect(fs.readFile(path.join(artifactsDir, "B.md"), "utf8")).resolves.toBe("B");
    await expect(fs.stat(path.join(artifactsDir, "C.zip"))).rejects.toThrow();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining(
        "Download timed out for B.md; skipped remaining expected file(s) to avoid misassigning a late completion: C.zip",
      ),
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining(
        "Download button fallback did not save expected file(s): B.md, C.zip",
      ),
    );
  });

  test("merges DOM and answer-text references for the same file", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-dedupe-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://chatgpt.com/backend-api/files/file_csv/download",
              downloadUrl: "https://chatgpt.com/backend-api/files/file_csv/download",
              sandboxUrl: "sandbox:/mnt/data/report.csv",
              filename: "report.csv",
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/files/file_csv/download",
      headers: { get: () => null },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as unknown as Response);

    const result = await collectChatGptFileArtifacts({
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
      answerText: "[Download](sandbox:/mnt/data/report.csv)",
    });

    expect(result.fileCount).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      downloadUrl: "https://chatgpt.com/backend-api/files/file_csv/download",
      sandboxUrl: "sandbox:/mnt/data/report.csv",
    });
    expect(result.savedFiles).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("scopes button fallback to failed files after a partial direct save", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-partial-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: {
            value: [
              {
                url: "https://chatgpt.com/backend-api/files/file_ok/download",
                downloadUrl: "https://chatgpt.com/backend-api/files/file_ok/download",
                filename: "ok.csv",
              },
              {
                url: "https://chatgpt.com/backend-api/files/file_missing/download",
                downloadUrl: "https://chatgpt.com/backend-api/files/file_missing/download",
                filename: "missing.csv",
              },
            ],
          },
        })
        .mockImplementationOnce(async () => {
          await fs.mkdir(artifactsDir, { recursive: true });
          await fs.writeFile(
            path.join(artifactsDir, "missing.csv"),
            "missing,value\nrow,2\n",
            "utf8",
          );
          return { result: { value: [{ text: "missing.csv", ariaLabel: "", testId: "" }] } };
        }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    const page = {
      setDownloadBehavior: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient["Page"];
    globalThis.fetch = vi.fn().mockImplementation(async (url: URL | string) => {
      const missing = String(url).includes("file_missing");
      return {
        ok: !missing,
        status: missing ? 404 : 200,
        statusText: missing ? "Not Found" : "OK",
        url: String(url),
        headers: { get: () => null },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      } as unknown as Response;
    });

    const result = await collectChatGptFileArtifacts({
      Page: page,
      Runtime: runtime,
      Network: network,
      sessionId,
    });

    expect(result.fileCount).toBe(2);
    expect(result.savedFiles).toHaveLength(2);
    expect(result.savedFiles.map((file) => file.filename)).toEqual(
      expect.arrayContaining(["ok.csv", "missing.csv"]),
    );
    expect(page.setDownloadBehavior).toHaveBeenCalledWith({
      behavior: "allow",
      downloadPath: artifactsDir,
    });
    expect(runtime.evaluate).toHaveBeenCalledTimes(2);
    const fallbackExpression = vi.mocked(runtime.evaluate).mock.calls[1]?.[0]?.expression;
    expect(fallbackExpression).toContain('"missing.csv"');
    expect(fallbackExpression).not.toContain('"ok.csv"');
    expect(fallbackExpression).toContain("const ALLOW_GENERIC_DOWNLOAD_LABELS = false");
  });

  test("normalizes only ChatGPT backend file URLs", () => {
    expect(__test__.normalizeChatGptDownloadUrl("https://example.com/file_1.zip")).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl("https://chatgpt.com/backend-api/me"),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl("https://chatgpt.com/backend-api/conversation/abc"),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/estuary/content?id=not_file",
      ),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/sandbox/download?path=%2Fetc%2Fpasswd",
      ),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/files/file_package/download",
      ),
    ).toBe("https://chatgpt.com/backend-api/files/file_package/download");
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Ffile.zip",
      ),
    ).toBe("https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Ffile.zip");
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/estuary/content?id=file_abc123",
      ),
    ).toBe("https://chatgpt.com/backend-api/estuary/content?id=file_abc123");
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://files.chatgpt.com/backend-api/files/file_package/download",
      ),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com:444/backend-api/files/file_package/download",
      ),
    ).toBeUndefined();
    expect(__test__.normalizeChatGptDownloadUrl("sandbox:/mnt/data/file.zip")).toBeUndefined();
    expect(__test__.normalizeSandboxUrl("sandbox:/mnt/data/file.zip")).toBe(
      "sandbox:/mnt/data/file.zip",
    );
    expect(__test__.normalizeSandboxUrl("sandbox:/mnt/data/../secret.txt")).toBeUndefined();
    expect(__test__.downloadUrlFromSandboxUrl("sandbox:/mnt/data/file.zip")).toBe(
      "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Ffile.zip",
    );
    expect(
      __test__.readTextDownloadableFiles(
        "[file](sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv)",
      )[0],
    ).toMatchObject({
      sandboxUrl: "sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv",
      filename: "oracle_pr245_file_artifact_smoke.csv",
    });
  });

  test("click expression prefers expected-label buttons across all turns", () => {
    const expectedButton = behaviorButton("Download file.csv");
    const newerGenericButton = behaviorButton("Download");
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(
      undefined,
      ["file.csv"],
      true,
      { markClicked: true, maxClicks: 1 },
    );

    const clicked = evaluateClickExpression(expression, [
      assistantTurn([expectedButton]),
      assistantTurn([newerGenericButton]),
    ]);

    expect(clicked).toEqual([{ text: "Download file.csv", ariaLabel: "", testId: "" }]);
    expect(expectedButton.clickCount).toBe(1);
    expect(newerGenericButton.clickCount).toBe(0);
  });

  test("click expression preserves broad generic matching when no files are expected", () => {
    const behaviorGeneric = behaviorButton("Download image");
    const exactFallback = new FakeElement("", {
      "data-testid": "download-files-turn-action-button",
    });
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(undefined, [], true);

    expect(
      evaluateClickExpression(expression, [
        assistantTurn([exactFallback]),
        assistantTurn([behaviorGeneric]),
      ]),
    ).toEqual([
      { text: "Download image", ariaLabel: "", testId: "" },
      { text: "", ariaLabel: "", testId: "download-files-turn-action-button" },
    ]);
    expect(behaviorGeneric.clickCount).toBe(1);
    expect(exactFallback.clickCount).toBe(1);
  });

  test("click expression falls back to generic buttons and skips already-clicked ones", () => {
    const firstGeneric = behaviorButton("Download");
    const secondGeneric = new FakeElement("", {
      "data-testid": "download-files-turn-action-button",
    });
    const expression = (filename: string) =>
      __test__.buildClickAssistantDownloadButtonsExpression(undefined, [filename], true, {
        markClicked: true,
        maxClicks: 1,
      });
    const turns = [assistantTurn([firstGeneric, secondGeneric])];

    expect(evaluateClickExpression(expression("A.txt"), turns)).toEqual([
      { text: "Download", ariaLabel: "", testId: "" },
    ]);
    expect(firstGeneric.getAttribute("data-oracle-download-clicked")).toBe("true");
    expect(evaluateClickExpression(expression("B.md"), turns)).toEqual([
      { text: "", ariaLabel: "", testId: "download-files-turn-action-button" },
    ]);
    expect(secondGeneric.getAttribute("data-oracle-download-clicked")).toBe("true");
    expect(firstGeneric.clickCount).toBe(1);
    expect(secondGeneric.clickCount).toBe(1);
  });

  test("matches ChatGPT behavior download buttons with descriptive labels", () => {
    const fileExpression = __test__.buildAssistantDownloadableFilesExpression();
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(undefined, [
      "oracle_pr245_file.csv",
    ]);
    const scopedExpression = __test__.buildClickAssistantDownloadButtonsExpression(
      undefined,
      ["oracle_pr245_file.csv"],
      false,
    );
    const oneClickExpression = __test__.buildClickAssistantDownloadButtonsExpression(
      undefined,
      ["oracle_pr245_file.csv"],
      true,
      { markClicked: true, maxClicks: 1 },
    );

    expect(fileExpression).toContain("files.push(...serializeFiles(messageRoot))");
    expect(fileExpression).not.toContain("if (files.length > 0) return files");
    expect(expression).toContain("/^download\\b/");
    expect(expression).not.toContain("/^download\b/");
    expect(expression).toContain('"oracle_pr245_file.csv"');
    expect(expression).toContain("const downloadLabel = 'download ' + label");
    expect(expression).toContain("text === downloadLabel");
    expect(expression).toContain("document.querySelectorAll(CONVERSATION_SELECTOR)");
    expect(expression).not.toContain("document.querySelectorAll('button')");
    expect(expression).toContain("const expectedMatches = new Set()");
    expect(expression).toContain("behaviorButtons.filter(expectedFileButton)");
    expect(expression).toContain("behaviorButtons.filter(genericBehaviorButton)");
    expect(expression).toContain("buttons.filter(genericFallbackButton)");
    expect(expression).toContain("expectedMatches.size > 0");
    expect(expression).toContain("genericBehaviorMatches.size > 0");
    expect(scopedExpression).toContain("const ALLOW_GENERIC_DOWNLOAD_LABELS = false");
    expect(oneClickExpression).toContain("const ALLOW_GENERIC_DOWNLOAD_LABELS = true");
    expect(oneClickExpression).toContain("const MARK_CLICKED = true");
    expect(oneClickExpression).toContain("const MAX_CLICKS = 1");
    expect(oneClickExpression).toContain("button.setAttribute(CLICKED_ATTRIBUTE, 'true')");
    const labels = __test__.resolveDownloadButtonLabels([
      {
        url: "sandbox:/mnt/data/oracle_pr245_file.csv",
        sandboxUrl: "sandbox:/mnt/data/oracle_pr245_file.csv",
        label: "Download the CSV",
      },
    ]);
    expect(labels).toHaveLength(2);
    expect(labels).toEqual(expect.arrayContaining(["oracle_pr245_file.csv", "download the csv"]));
  });
});
