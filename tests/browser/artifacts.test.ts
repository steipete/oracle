import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendArtifacts,
  resolveSessionArtifactsDir,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
  isZipArtifact,
  validateArtifactFile,
  validateZipBuffer,
  writeBinaryBrowserArtifact,
  __test__,
} from "../../src/browser/artifacts.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

describe("browser session artifacts", () => {
  afterEach(() => {
    setOracleHomeDirOverrideForTest(null);
  });

  test("writes Deep Research reports into the session artifacts directory", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-artifacts-"));
    setOracleHomeDirOverrideForTest(tmpHome);

    const artifact = await saveDeepResearchReportArtifact({
      sessionId: "steam-export-audit",
      reportMarkdown:
        "CHECK_DEEP_OK This completed report includes enough content to be saved.\nhttps://example.com/source",
      conversationUrl: "https://chatgpt.com/c/abc",
    });

    expect(artifact).toMatchObject({
      kind: "deep-research-report",
      label: "Deep Research report",
      mimeType: "text/markdown",
      sourceUrl: "https://chatgpt.com/c/abc",
    });
    expect(artifact?.path).toBe(
      path.join(tmpHome, "sessions", "steam-export-audit", "artifacts", "deep-research-report.md"),
    );
    await expect(fs.readFile(artifact!.path, "utf8")).resolves.toContain("CHECK_DEEP_OK");
  });

  test("does not save tool-call placeholders as Deep Research reports", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-artifacts-"));
    setOracleHomeDirOverrideForTest(tmpHome);

    await expect(
      saveDeepResearchReportArtifact({
        sessionId: "tool-placeholder",
        reportMarkdown: "Called tool",
      }),
    ).resolves.toBeNull();
  });

  test("does not save Deep Research planning panels as reports", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-artifacts-"));
    setOracleHomeDirOverrideForTest(tmpHome);

    await expect(
      saveDeepResearchReportArtifact({
        sessionId: "planning-placeholder",
        reportMarkdown:
          "project root-cause analysis\nUpdate\nInspect the adapter.\nDetermining steps for creating a report...\nStop research",
      }),
    ).resolves.toBeNull();
  });

  test("writes a transcript with prompt, answer, conversation URL, and artifact references", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-transcript-"));
    setOracleHomeDirOverrideForTest(tmpHome);

    const transcript = await saveBrowserTranscriptArtifact({
      sessionId: "browser-answer",
      prompt: "What changed?",
      answerMarkdown: "The patch now saves artifacts.",
      conversationUrl: "https://chatgpt.com/c/abc",
      artifacts: [
        {
          kind: "deep-research-report",
          path: "/tmp/report.md",
          label: "Deep Research report",
        },
      ],
    });

    expect(transcript?.path).toContain(resolveSessionArtifactsDir("browser-answer"));
    const saved = await fs.readFile(transcript!.path, "utf8");
    expect(saved).toContain("## Prompt");
    expect(saved).toContain("What changed?");
    expect(saved).toContain("## Answer");
    expect(saved).toContain("The patch now saves artifacts.");
    expect(saved).toContain("Conversation: https://chatgpt.com/c/abc");
    expect(saved).toContain("Deep Research report: /tmp/report.md");
  });

  test("writes binary file artifacts into the session artifacts directory", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-file-artifacts-"));
    setOracleHomeDirOverrideForTest(tmpHome);

    const artifact = await writeBinaryBrowserArtifact({
      sessionId: "browser-files",
      kind: "file",
      filename: "Build Output.zip",
      contents: Buffer.from([1, 2, 3]),
      label: "Build output",
      mimeType: "application/zip",
      sourceUrl: "sandbox:/mnt/data/Build Output.zip",
    });

    expect(artifact).toMatchObject({
      kind: "file",
      label: "Build output",
      mimeType: "application/zip",
      sourceUrl: "sandbox:/mnt/data/Build Output.zip",
      sizeBytes: 3,
      validation: { type: "zip", ok: false, error: "zip-too-small" },
      transfer: { status: "not-needed" },
      origin: { mode: "local" },
    });
    expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact?.path).toBe(
      path.join(tmpHome, "sessions", "browser-files", "artifacts", "build-output.zip"),
    );
    await expect(fs.readFile(artifact!.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  test("validates empty ZIP central directory metadata", () => {
    const emptyZip = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    expect(validateZipBuffer(emptyZip)).toEqual({ type: "zip", ok: true });
    expect(validateZipBuffer(Buffer.from([1, 2, 3]))).toEqual({
      type: "zip",
      ok: false,
      error: "zip-too-small",
    });
  });

  test("validates ZIP files from bounded file windows", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-zip-file-validation-"));
    const emptyZip = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const validPath = path.join(tmpHome, "valid.zip");
    const invalidPath = path.join(tmpHome, "invalid.zip");
    await fs.writeFile(validPath, emptyZip);
    await fs.writeFile(invalidPath, Buffer.concat([emptyZip, Buffer.from("trailing")]));

    await expect(validateArtifactFile({ path: validPath, filename: "valid.zip" })).resolves.toEqual(
      {
        type: "zip",
        ok: true,
      },
    );
    await expect(
      validateArtifactFile({ path: invalidPath, filename: "invalid.zip" }),
    ).resolves.toEqual({
      type: "zip",
      ok: false,
      error: "zip-eocd-size-mismatch",
    });
  });

  test("does not classify gzip archives as ZIP files", () => {
    expect(isZipArtifact("source.tar.gz", "application/gzip")).toBe(false);
    expect(isZipArtifact("source.gz", "application/x-gzip")).toBe(false);
    expect(isZipArtifact("source.zip", "application/octet-stream")).toBe(true);
    expect(isZipArtifact("source.bin", "application/zip")).toBe(true);
    expect(isZipArtifact("source.bin", "application/example+zip")).toBe(true);
  });

  test("dedupes artifact lists by kind and path", () => {
    const artifact = { kind: "transcript" as const, path: "/tmp/transcript.md" };
    expect(appendArtifacts([artifact], [artifact, null, undefined])).toEqual([artifact]);
  });

  test("sanitizes path segments used for session artifact paths", () => {
    expect(__test__.normalizeSessionId("../bad session")).toBe("bad-session");
  });
});
