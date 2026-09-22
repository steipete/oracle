import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
let oracleHome: string;
let sourceFile: string;
const sessionId = "test-shadowed-globals";
const projectUrl = "https://chatgpt.com/g/g-p-69505ed97e3081918a275477a647a682/project";

beforeAll(async () => {
  oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-shadowed-"));
  const sessionDir = path.join(oracleHome, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({
      id: sessionId,
      status: "completed",
      createdAt: now,
      completedAt: now,
      mode: "api",
      model: "gpt-5.5",
      cwd: "/tmp",
      options: { prompt: "the stored prompt text" },
      models: [
        {
          model: "gpt-5.5",
          status: "completed",
          log: { path: "models/gpt-5.5.log" },
          startedAt: now,
          completedAt: now,
        },
      ],
    }),
  );
  await writeFile(path.join(sessionDir, "output.log"), "Answer:\n# Hello\n");
  await mkdir(path.join(sessionDir, "models"));
  await writeFile(path.join(sessionDir, "models", "gpt-5.5.log"), "Answer:\n# Hello\n");
  // Legacy session without a per-model `models` array or per-model logs.
  const legacyDir = path.join(oracleHome, "sessions", "test-shadowed-legacy");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(
    path.join(legacyDir, "meta.json"),
    JSON.stringify({
      id: "test-shadowed-legacy",
      status: "completed",
      createdAt: now,
      completedAt: now,
      mode: "api",
      model: "gpt-5.5",
      cwd: "/tmp",
    }),
  );
  await writeFile(path.join(legacyDir, "output.log"), "Answer:\n# Legacy Hello\n");
  sourceFile = path.join(oracleHome, "source.txt");
  await writeFile(sourceFile, "project source content\n");
});

afterAll(async () => {
  await rm(oracleHome, { recursive: true, force: true });
});

async function oracle(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ORACLE_")) {
      delete env[key];
    }
  }
  env.ORACLE_HOME_DIR = oracleHome;
  env.ORACLE_FORCE_TUI = "0";
  env.NO_COLOR = "1";
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(process.cwd(), "bin/oracle-cli.ts"), ...args],
      { env, timeout: 30_000 },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : -1,
    };
  }
}

// Regression coverage for global flags that collide with subcommand declarations:
// commander stores the value on the root program, so handlers must read
// optsWithGlobals() instead of the subcommand's local opts().

test.each([
  ["session", [sessionId]],
  ["session", []],
  ["status", [sessionId]],
  ["status", []],
])(
  "%s honors --model (argv: %j)",
  async (command, idArg) => {
    const listed = await oracle([command, ...idArg, "--model", "gpt-5.5"]);
    expect(listed.stdout).toContain(sessionId === idArg[0] ? "Answer:" : sessionId);
    const mismatch = await oracle([command, ...idArg, "--model", "nonexistent"]);
    if (idArg.length > 0) {
      expect(mismatch.stderr).toContain(`Model "nonexistent" not found in session ${sessionId}.`);
      expect(mismatch.code).toBe(1);
    } else {
      expect(mismatch.stdout).not.toContain(sessionId);
    }
  },
  60_000,
);

test("session attach honors --model passed before the subcommand", async () => {
  const mismatch = await oracle(["--model", "nonexistent", "session", sessionId]);
  expect(mismatch.stderr).toContain(`Model "nonexistent" not found in session ${sessionId}.`);
  expect(mismatch.code).toBe(1);
}, 20_000);

test.each(["session", "status"])(
  "%s attach honors --render outside a TTY",
  async (command) => {
    const run = await oracle([command, sessionId, "--render"]);
    expect(run.stdout).toContain("Render requested but stdout is not a TTY");
  },
  30_000,
);

test("session attach honors --verbose-render", async () => {
  const run = await oracle(["session", sessionId, "--render", "--verbose-render"]);
  expect(run.stdout).toContain("Verbose: renderMarkdown=true tty=false");
}, 20_000);

test("session attach does not warn about honored --hide-prompt", async () => {
  const hidden = await oracle(["session", sessionId, "--hide-prompt"]);
  expect(hidden.stdout).not.toContain("Ignoring flags");
  expect(hidden.stdout).not.toContain("the stored prompt text");
  const shown = await oracle(["session", sessionId]);
  expect(shown.stdout).toContain("the stored prompt text");
}, 30_000);

test("session attach warns about root flags it ignores", async () => {
  const run = await oracle(["session", sessionId, "--engine", "browser"]);
  expect(run.stdout).toContain("Ignoring flags on session attach: engine");
}, 20_000);

test("session attach falls back to the session log for legacy sessions", async () => {
  const run = await oracle(["session", "test-shadowed-legacy", "--model", "gpt-5.5"]);
  expect(run.stdout).toContain("Answer:");
  expect(run.stdout).toContain("Legacy Hello");
}, 20_000);

test("legacy --session/--status aliases ignore configured default model", async () => {
  const configPath = path.join(oracleHome, "config.json");
  await writeFile(configPath, JSON.stringify({ model: "configured-other-model" }));
  try {
    const attached = await oracle(["--session", sessionId]);
    expect(attached.code).toBe(0);
    expect(attached.stdout).toContain("Answer:");
    const listed = await oracle(["--status"]);
    expect(listed.stdout).toContain(sessionId);
  } finally {
    await rm(configPath, { force: true });
  }
}, 60_000);

test("legacy --session alias still honors an explicit --model", async () => {
  const attached = await oracle(["--session", sessionId, "--model", "gpt-5.5"]);
  expect(attached.stdout).toContain("Answer:");
  const mismatch = await oracle(["--session", sessionId, "--model", "nonexistent"]);
  expect(mismatch.stderr).toContain(`Model "nonexistent" not found in session ${sessionId}.`);
  expect(mismatch.code).toBe(1);
}, 40_000);

test("project-sources add still resolves root --include alias", async () => {
  const run = await oracle([
    "project-sources",
    "add",
    "--include",
    sourceFile,
    "--dry-run",
    "--chatgpt-url",
    projectUrl,
  ]);
  expect(run.stdout).toContain("Planned uploads: 1");
  expect(run.stdout).not.toContain("requires at least one --file");
}, 30_000);
