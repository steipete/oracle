import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  buildDetachedPerfTraceEnv,
  deriveDetachedPerfTraceEnv,
  resolveDetachedPerfTraceEnv,
  sanitizeTraceArgv,
} from "../../src/cli/perfTrace.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");
const TSX_LOADER = path.join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs");
const CLI_TIMEOUT = 15_000;

describe("CLI performance traces", () => {
  test("redacts prompt and token arguments", () => {
    expect(
      sanitizeTraceArgv([
        "-psecret prompt",
        "--prompt=secret prompt",
        "--browser-follow-up=sensitive follow-up",
        "--token",
        "service-token",
        "--connect=oracle+tcp://example.com:1234?token=service-token",
        "--remote-token=remote-secret",
        "--browser-inline-cookies",
        "[cookie-json]",
        "--",
        "--ask=private-details",
      ]),
    ).toEqual([
      "-p[redacted]",
      "--prompt=[redacted]",
      "--browser-follow-up=[redacted]",
      "--token",
      "[redacted]",
      "--connect=oracle+tcp://example.com:1234?token=[redacted]",
      "--remote-token=[redacted]",
      "--browser-inline-cookies",
      "[redacted]",
      "--",
      "[redacted-positional]",
    ]);
  });

  test("moves inherited explicit env trace paths to detached child sidecars", () => {
    expect(deriveDetachedPerfTraceEnv("/tmp/oracle-trace.json", "abc123")).toBe(
      "/tmp/oracle-trace.abc123.json",
    );
    expect(deriveDetachedPerfTraceEnv("/tmp/oracle-trace", "abc/123")).toBe(
      "/tmp/oracle-trace.abc_123.json",
    );
    expect(deriveDetachedPerfTraceEnv("1", "abc123")).toBe("1");
  });

  test("propagates CLI trace settings to detached children", () => {
    expect(resolveDetachedPerfTraceEnv("/tmp/parent.json", undefined, "abc123")).toBe(
      "/tmp/parent.abc123.json",
    );
    expect(resolveDetachedPerfTraceEnv(true, "/tmp/env.json", "abc123")).toBe("1");
    expect(resolveDetachedPerfTraceEnv(undefined, "/tmp/env.json", "abc123")).toBe(
      "/tmp/env.abc123.json",
    );
  });

  test("omits unset trace env for detached children", () => {
    expect(buildDetachedPerfTraceEnv({}, undefined, "abc123")).not.toHaveProperty(
      "ORACLE_PERF_TRACE",
    );
    expect(
      buildDetachedPerfTraceEnv({ ORACLE_PERF_TRACE: undefined }, undefined, "abc123"),
    ).not.toHaveProperty("ORACLE_PERF_TRACE");
    expect(
      buildDetachedPerfTraceEnv({ ORACLE_PERF_TRACE: "/tmp/env.json" }, undefined, "abc123")
        .ORACLE_PERF_TRACE,
    ).toBe("/tmp/env.abc123.json");
    expect(
      buildDetachedPerfTraceEnv({ ORACLE_PERF_TRACE: "/tmp/env.json" }, true, "abc123")
        .ORACLE_PERF_TRACE,
    ).toBe("1");
  });

  test(
    "writes trace for help early exits",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-perf-trace-"));
      const tracePath = path.join(tmp, "help-trace.json");

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, `--perf-trace=${tracePath}`, "--help"],
        { timeout: CLI_TIMEOUT },
      );

      expect(stdout).toContain("Oracle CLI");
      const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
        totalMs: number;
        events: Array<{ name: string; ms: number }>;
      };
      expect(trace.totalMs).toBeGreaterThan(0);
      expect(trace.events.map((event) => event.name)).toEqual(
        expect.arrayContaining(["cli-module-ready", "first-output", "exit"]),
      );

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "accepts equals form for explicit trace path",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-perf-trace-"));
      const tracePath = path.join(tmp, "equals-trace.json");

      await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, `--perf-trace-path=${tracePath}`, "--help"],
        { timeout: CLI_TIMEOUT },
      );

      const trace = JSON.parse(await readFile(tracePath, "utf8")) as { totalMs: number };
      expect(trace.totalMs).toBeGreaterThan(0);

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "keeps perf-only invocation on the zero-argument path",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-perf-trace-"));
      const tracePath = path.join(tmp, "no-args-trace.json");

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--perf-trace", "--perf-trace-path", tracePath],
        { timeout: CLI_TIMEOUT },
      );

      expect(stdout).toContain("No prompt or subcommand supplied");
      expect(stderr).not.toContain("Prompt is required when starting a new session");
      const trace = JSON.parse(await readFile(tracePath, "utf8")) as { totalMs: number };
      expect(trace.totalMs).toBeGreaterThan(0);

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "rejects a missing trace path before another option is consumed",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-perf-trace-"));

      await expect(
        execFileAsync(
          process.execPath,
          [
            "--import",
            TSX_LOADER,
            CLI_ENTRY,
            "--perf-trace-path",
            "--model",
            "gpt-5.1",
            "-p",
            "hi",
          ],
          { cwd: tmp, timeout: CLI_TIMEOUT },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("option '--perf-trace-path <path>' argument missing"),
      });

      expect((await readdir(tmp)).some((entry) => entry.startsWith(".oracle-perf-"))).toBe(false);

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "does not rewrite prompt values that look like perf flags",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-perf-trace-"));
      const traceTarget = path.join(tmp, "should-not-exist.json");
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-perf-trace-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: "INLINE_TEST_FACTORY",
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          TSX_LOADER,
          CLI_ENTRY,
          "--provider",
          "openai",
          "--model",
          "gpt-5.1",
          "--no-background",
          "--dry-run",
          "summary",
          "-p",
          `--perf-trace=${traceTarget}`,
        ],
        { cwd: tmp, env, timeout: CLI_TIMEOUT },
      );

      expect(stdout).toContain("[dry-run] Oracle");
      expect(await readdir(tmp)).not.toContain("should-not-exist.json");

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "does not detect perf flags after the positional delimiter",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-perf-trace-"));
      const traceTarget = path.join(tmp, "prompt-token.json");
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-perf-trace-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: "INLINE_TEST_FACTORY",
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          TSX_LOADER,
          CLI_ENTRY,
          "--provider",
          "openai",
          "--model",
          "gpt-5.1",
          "--no-background",
          "--dry-run",
          "summary",
          "--",
          `--perf-trace-path=${traceTarget}`,
        ],
        { cwd: tmp, env, timeout: CLI_TIMEOUT },
      );

      expect(stdout).toContain("[dry-run] Oracle");
      expect(await readdir(tmp)).not.toContain("prompt-token.json");

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "does not change bridge config output routing",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-perf-trace-"));
      const tracePath = path.join(tmp, "bridge-trace.json");

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--perf-trace",
          "--perf-trace-path",
          tracePath,
          "bridge",
          "codex-config",
        ],
        { timeout: CLI_TIMEOUT },
      );

      expect(stdout).toMatch(/^# ~\/\.codex\/config\.toml/);
      expect(stdout).not.toContain("🧿 oracle");
      await readFile(tracePath, "utf8");

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "writes startup and first-output timing trace",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-perf-trace-"));
      const tracePath = path.join(tmp, "trace.json");
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-perf-trace-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: tmp,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--preflight",
          "--model",
          "gpt-5.4",
          "--provider",
          "openai",
          "--perf-trace-path",
          tracePath,
          "--perf-trace",
        ],
        { env, timeout: CLI_TIMEOUT },
      );

      expect(stdout).toContain("Provider preflight");
      const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
        totalMs: number;
        events: Array<{ name: string; ms: number }>;
      };
      expect(trace.totalMs).toBeGreaterThan(0);
      expect(trace.events.map((event) => event.name)).toEqual(
        expect.arrayContaining(["cli-module-ready", "pre-action", "first-output", "exit"]),
      );
      const firstOutput = trace.events.find((event) => event.name === "first-output");
      expect(firstOutput?.ms).toBeGreaterThan(0);
      expect(JSON.stringify(trace)).not.toContain("sk-perf-trace-key");

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "does not consume positional prompt or persist prompt text",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-perf-trace-"));
      const tracePath = path.join(tmp, "prompt-trace.json");
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-perf-trace-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: "INLINE_TEST_FACTORY",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: tmp,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--provider",
          "openai",
          "--perf-trace",
          "--perf-trace-path",
          tracePath,
          "--model",
          "gpt-5.1",
          "--no-background",
          "sensitive prompt text",
        ],
        { env, timeout: CLI_TIMEOUT },
      );

      expect(stdout).toContain("Session: sensitive-prompt-text");
      const traceText = await readFile(tracePath, "utf8");
      expect(traceText).not.toContain("sensitive prompt text");
      expect(traceText).not.toContain("sk-perf-trace-key");
      const trace = JSON.parse(traceText) as {
        argv: string[];
        events: Array<{ name: string; data?: Record<string, unknown> }>;
      };
      expect(trace.argv).toContain("[redacted-positional]");
      expect(trace.events.find((event) => event.name === "pre-action")?.data?.command).toBe(
        "oracle",
      );

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );
});
