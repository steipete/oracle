import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");
const CLIENT_FACTORY = path.join(process.cwd(), "tests", "fixtures", "mockClientFactory.cjs");
const INTEGRATION_TIMEOUT = 60000;
const AZURE_ENV_KEYS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
] as const;
const originalAzureEnv = Object.fromEntries(AZURE_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of AZURE_ENV_KEYS) {
    delete process.env[key];
  }
});

afterAll(() => {
  for (const key of AZURE_ENV_KEYS) {
    const value = originalAzureEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("oracle CLI integration", () => {
  test(
    "stores session metadata using stubbed client factory",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-home-"));
      const testFile = path.join(oracleHome, "notes.md");
      await writeFile(testFile, "Integration dry run content", "utf8");

      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Integration check",
          "--model",
          "gpt-5.1",
          "--file",
          testFile,
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const sessionIds = await readdir(sessionsDir);
      expect(sessionIds.length).toBe(1);
      const metadataPath = path.join(sessionsDir, sessionIds[0], "meta.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      expect(metadata.status).toBe("completed");
      expect(metadata.response?.requestId).toBe("mock-req");
      expect(metadata.usage?.totalTokens).toBe(20);
      expect(metadata.options?.effectiveModelId).toBe("gpt-5.1");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "honors --provider openai by ignoring Azure env routing",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-openai-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--provider",
          "openai",
          "--prompt",
          "Provider route check",
          "--model",
          "gpt-5.1",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      const metadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(metadata.options?.azure).toBeUndefined();
      expect(metadata.options?.provider).toBe("openai");
      expect(stdout).toContain("Provider: OpenAI | base: api.openai.com | key: OPENAI_API_KEY");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "stores resolved transport and stale timeouts from explicit overall timeout",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-timeout-plan-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Timeout plan check",
          "--model",
          "gpt-5.1",
          "--timeout",
          "10m",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      const metadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(metadata.options?.timeoutSeconds).toBe(600);
      expect(metadata.options?.httpTimeoutMs).toBe(600_000);
      expect(metadata.options?.zombieTimeoutMs).toBe(600_000);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "keeps Gemini dry-runs in browser mode when Azure env is present",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-gemini-azure-"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        DOTENV_CONFIG_PATH: "/tmp/nonexistent-oracle-env",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      delete env.OPENAI_API_KEY;
      delete env.GEMINI_API_KEY;
      delete env.OPENROUTER_API_KEY;
      delete env.ORACLE_ENGINE;

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--dry-run",
          "--prompt",
          "Gemini browser route check",
          "--model",
          "gemini-3-pro",
        ],
        { env },
      );

      expect(stdout).toContain("[preview] Oracle");
      expect(stdout).toContain("browser mode (gemini-3-pro)");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "honors ORACLE_ENGINE browser when Azure env is present",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-engine-browser-"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "configured-gpt",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_ENGINE: "browser",
        // biome-ignore lint/style/useNamingConvention: env var name
        DOTENV_CONFIG_PATH: "/tmp/nonexistent-oracle-env",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      delete env.OPENAI_API_KEY;
      delete env.GEMINI_API_KEY;
      delete env.OPENROUTER_API_KEY;

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--dry-run",
          "--prompt",
          "Engine browser route check",
          "--model",
          "gpt-5.1",
        ],
        { env },
      );

      expect(stdout).toContain("[preview] Oracle");
      expect(stdout).toContain("browser mode (gpt-5.1)");
      expect(stdout).not.toContain("Provider: Azure OpenAI");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "persists explicit Azure provider mode for custom deployment sessions",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-azure-"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        DOTENV_CONFIG_PATH: "/tmp/nonexistent-oracle-env",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      delete env.OPENAI_API_KEY;

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--provider",
          "azure",
          "--azure-deployment",
          "my-o3",
          "--prompt",
          "Azure provider route check",
          "--model",
          "o3-mini",
          "--no-background",
          "--wait",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      const metadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(metadata.options?.provider).toBe("azure");
      expect(metadata.options?.azure?.deployment).toBe("my-o3");
      expect(stdout).toContain(
        "Provider: Azure OpenAI | endpoint: example-resource.openai.azure.com | deployment: my-o3 | key: AZURE_OPENAI_API_KEY|OPENAI_API_KEY",
      );

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects missing Azure deployment before detached Pro sessions start",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-detach-azure-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "Detached Azure provider route check",
            "--model",
            "gpt-5-pro",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/Azure mode requires --azure-deployment/i);
      }

      const sessionsDir = path.join(oracleHome, "sessions");
      let sessionIds: string[] = [];
      try {
        sessionIds = await readdir(sessionsDir);
      } catch {
        sessionIds = [];
      }
      expect(sessionIds).toEqual([]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects forced OpenAI non-OpenAI models before detached Pro sessions start",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-detach-openai-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--provider",
            "openai",
            "--prompt",
            "Detached OpenAI provider route check",
            "--model",
            "claude-4.6-sonnet",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/OpenAI provider cannot run claude-4\.6-sonnet/i);
      }

      const sessionsDir = path.join(oracleHome, "sessions");
      let sessionIds: string[] = [];
      try {
        sessionIds = await readdir(sessionsDir);
      } catch {
        sessionIds = [];
      }
      expect(sessionIds).toEqual([]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects forced OpenAI provider-qualified non-OpenAI dry-runs before sessions start",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-dry-openai-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        DOTENV_CONFIG_PATH: "/tmp/nonexistent-oracle-env",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--dry-run",
            "--provider",
            "openai",
            "--prompt",
            "Dry-run provider route check",
            "--model",
            "anthropic/claude-sonnet-4.5",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/OpenAI provider cannot run anthropic\/claude-sonnet-4\.5/i);
      }

      const sessionsDir = path.join(oracleHome, "sessions");
      let sessionIds: string[] = [];
      try {
        sessionIds = await readdir(sessionsDir);
      } catch {
        sessionIds = [];
      }
      expect(sessionIds).toEqual([]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects invalid forced provider multi-model runs before any session starts",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-multi-openai-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--provider",
            "openai",
            "--prompt",
            "Multi-provider route check",
            "--models",
            "gpt-5.1,claude-4.6-sonnet",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/OpenAI provider cannot run claude-4\.6-sonnet/i);
      }

      const sessionsDir = path.join(oracleHome, "sessions");
      let sessionIds: string[] = [];
      try {
        sessionIds = await readdir(sessionsDir);
      } catch {
        sessionIds = [];
      }
      expect(sessionIds).toEqual([]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "persists followup lineage and reuses previous_response_id during --exec-session",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--prompt", "Parent run", "--model", "gpt-5.1"],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [parentId] = await readdir(sessionsDir);
      expect(parentId).toBeTruthy();
      const parentMeta = JSON.parse(
        await readFile(path.join(sessionsDir, parentId, "meta.json"), "utf8"),
      );
      const parentResponseId = String(parentMeta.response?.responseId ?? "");
      expect(parentResponseId.startsWith("resp_")).toBe(true);

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Child run",
          "--model",
          "gpt-5.1",
          "--followup",
          parentId,
        ],
        { env },
      );

      const allSessions = await readdir(sessionsDir);
      expect(allSessions.length).toBe(2);
      const childId = allSessions.find((id) => id !== parentId);
      expect(childId).toBeTruthy();
      const childMeta = JSON.parse(
        await readFile(path.join(sessionsDir, childId as string, "meta.json"), "utf8"),
      );
      expect(childMeta.options?.previousResponseId).toBe(parentResponseId);
      expect(childMeta.options?.followupSessionId).toBe(parentId);

      await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--exec-session", childId as string],
        {
          env: {
            ...env,
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_TEST_REQUIRE_PREV: "1",
          },
        },
      );

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "accepts direct response ids in --followup and persists chain metadata",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-resp-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      const directResponseId = "resp_direct_followup_12345";

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Child from direct response id",
          "--model",
          "gpt-5.1",
          "--followup",
          directResponseId,
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      expect(sessionId).toBeTruthy();
      const metadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(metadata.options?.previousResponseId).toBe(directResponseId);
      expect(metadata.options?.followupSessionId).toBeUndefined();
      expect(metadata.options?.followupModel).toBeUndefined();

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects --followup for Gemini API runs",
    async () => {
      const oracleHome = await mkdtemp(
        path.join(os.tmpdir(), "oracle-followup-gemini-unsupported-"),
      );
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "Gemini followup",
            "--model",
            "gemini-3-pro",
            "--followup",
            "resp_parent_1234",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/only supported for OpenAI Responses API runs/i);
        expect(stderr).toMatch(/gemini-3-pro/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects --followup for Claude API runs",
    async () => {
      const oracleHome = await mkdtemp(
        path.join(os.tmpdir(), "oracle-followup-claude-unsupported-"),
      );
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        ANTHROPIC_API_KEY: "ak-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "Claude followup",
            "--model",
            "claude-4.6-sonnet",
            "--followup",
            "resp_parent_1234",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/only supported for OpenAI Responses API runs/i);
        expect(stderr).toMatch(/claude-4.6-sonnet/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects --followup for custom --base-url providers",
    async () => {
      const oracleHome = await mkdtemp(
        path.join(os.tmpdir(), "oracle-followup-baseurl-unsupported-"),
      );
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENROUTER_API_KEY: "or-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "OpenRouter followup",
            "--model",
            "gpt-5.1",
            "--base-url",
            "https://openrouter.ai/api/v1",
            "--followup",
            "resp_parent_1234",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/default OpenAI Responses API or Azure OpenAI Responses/i);
        expect(stderr).toMatch(/Custom --base-url providers are not supported/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "prints actionable guidance when --followup session id is missing",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-missing-id-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Parent run for followup suggestions",
          "--model",
          "gpt-5.1",
          "--slug",
          "release-readiness-audit",
        ],
        { env },
      );

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "Child with typo followup id",
            "--model",
            "gpt-5.1",
            "--followup",
            "release-readiness-audti",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/No session found with ID release-readiness-audti/i);
        expect(stderr).toMatch(/Did you mean:\s+"release-readiness-audit"/i);
        expect(stderr).toMatch(/oracle status --hours 72 --limit 20/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "requires --followup-model when parent session has multiple model runs",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-multi-error-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Parent multi followup",
          "--models",
          "gpt-5.1,gpt-5.2",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [parentId] = await readdir(sessionsDir);
      expect(parentId).toBeTruthy();

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "Child missing followup model",
            "--model",
            "gpt-5.1",
            "--followup",
            parentId,
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/multiple model runs/i);
        expect(stderr).toMatch(/--followup-model/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "uses --followup-model to continue from the selected parent model response",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-multi-select-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Parent multi followup select",
          "--models",
          "gpt-5.1,gpt-5.2",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [parentId] = await readdir(sessionsDir);
      expect(parentId).toBeTruthy();

      const parentMeta = JSON.parse(
        await readFile(path.join(sessionsDir, parentId, "meta.json"), "utf8"),
      );
      const selectedRun = (
        (parentMeta.models as
          | Array<{ model: string; response?: { responseId?: string } }>
          | undefined) ?? []
      ).find((run) => run.model === "gpt-5.2");
      const selectedResponseId = selectedRun?.response?.responseId;
      expect(selectedResponseId).toBeTruthy();
      expect(String(selectedResponseId).startsWith("resp_")).toBe(true);

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Child with followup model select",
          "--model",
          "gpt-5.1",
          "--followup",
          parentId,
          "--followup-model",
          "gpt-5.2",
        ],
        { env },
      );

      const allSessions = await readdir(sessionsDir);
      expect(allSessions.length).toBe(2);
      const childId = allSessions.find((id) => id !== parentId);
      expect(childId).toBeTruthy();
      const childMeta = JSON.parse(
        await readFile(path.join(sessionsDir, childId as string, "meta.json"), "utf8"),
      );
      expect(childMeta.options?.previousResponseId).toBe(selectedResponseId);
      expect(childMeta.options?.followupSessionId).toBe(parentId);
      expect(childMeta.options?.followupModel).toBe("gpt-5.2");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects mixing --model and --models regardless of source",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-multi-conflict-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "conflict",
            "--model",
            "gpt-5.1",
            "--models",
            "gpt-5.1-pro",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/--models cannot be combined with --model/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "runs gpt-5.1-codex via API-only path",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-codex-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--prompt", "Codex integration", "--model", "gpt-5.1-codex"],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const sessionIds = await readdir(sessionsDir);
      expect(sessionIds.length).toBe(1);
      const metadataPath = path.join(sessionsDir, sessionIds[0], "meta.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      expect(metadata.model).toBe("gpt-5.1-codex");
      expect(metadata.mode).toBe("api");
      expect(metadata.usage?.totalTokens).toBe(20);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects gpt-5.1-codex-max until OpenAI ships the API",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-codex-max-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "Codex Max integration",
            "--model",
            "gpt-5.1-codex-max",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/codex-max is not available yet/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "runs multi-model across OpenAI, Gemini, and Claude with custom factory",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-multi-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ANTHROPIC_API_KEY: "ak-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: path.join(process.cwd(), "tests", "fixtures", "mockPolyClient.cjs"),
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Multi run test prompt long enough",
          "--models",
          "gpt-5.1,gemini-3-pro,claude-4.6-sonnet",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const sessionIds = await readdir(sessionsDir);
      expect(sessionIds.length).toBe(1);
      const sessionDir = path.join(sessionsDir, sessionIds[0]);
      const metadata = JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8"));
      const selectedModels = (metadata.models as Array<{ model: string }> | undefined)?.map(
        (m: { model: string }) => m.model,
      );
      expect(selectedModels).toEqual(
        expect.arrayContaining(["gpt-5.1", "gemini-3-pro", "claude-4.6-sonnet"]),
      );
      expect(metadata.status).toBe("completed");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "allows partial multi-model success and reports saved outputs before failures",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-multi-partial-"));
      const outputPath = path.join(oracleHome, "answer.md");
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: path.join(process.cwd(), "tests", "fixtures", "mockPolyClient.cjs"),
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_TEST_FAIL_MODEL: "gemini-3-pro",
      };

      const result = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Partial multi-model run prompt long enough",
          "--models",
          "gpt-5.1,gemini-3-pro",
          "--allow-partial",
          "--write-output",
          outputPath,
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      const sessionDir = path.join(sessionsDir, sessionId);
      const metadata = JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8"));
      expect(metadata.status).toBe("partial");
      expect(metadata.options?.partialMode).toBe("ok");
      expect(await readFile(path.join(oracleHome, "answer.gpt-5.1.md"), "utf8")).toContain(
        "Echo(gpt-5.1)",
      );

      const savedIndex = result.stdout.indexOf("Saved outputs:");
      const failuresIndex = result.stdout.indexOf("Failures:");
      expect(result.stdout).toContain("Multi-model result: partial success, 1/2 succeeded");
      expect(savedIndex).toBeGreaterThanOrEqual(0);
      expect(failuresIndex).toBeGreaterThan(savedIndex);
      expect(result.stdout).toContain("gemini-3-pro");

      await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--exec-session", sessionId],
        {
          env,
        },
      );
      const rerunMetadata = JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8"));
      expect(rerunMetadata.status).toBe("partial");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "accepts shorthand multi-model list and normalizes to canonical IDs",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-multi-shorthand-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ANTHROPIC_API_KEY: "ak-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: path.join(process.cwd(), "tests", "fixtures", "mockPolyClient.cjs"),
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Shorthand multi-model normalization prompt that is safely over twenty characters.",
          "--models",
          "gpt-5.1,gemini,sonnet",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const sessionIds = await readdir(sessionsDir);
      expect(sessionIds.length).toBe(1);
      const sessionDir = path.join(sessionsDir, sessionIds[0]);
      const metadata = JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8"));
      const selectedModels = (metadata.models as Array<{ model: string }> | undefined)?.map(
        (m: { model: string }) => m.model,
      );
      expect(selectedModels).toEqual(
        expect.arrayContaining(["gpt-5.1", "gemini-3-pro", "claude-4.6-sonnet"]),
      );
      expect(metadata.status).toBe("completed");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "honors --max-file-size-bytes for root dry-runs ahead of env defaults",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-max-file-"));
      const testFile = path.join(oracleHome, "large.txt");
      await writeFile(testFile, "x".repeat(64), "utf8");

      const env = {
        ...process.env,
        ORACLE_HOME_DIR: oracleHome,
        ORACLE_DISABLE_KEYTAR: "1",
        ORACLE_MAX_FILE_SIZE_BYTES: "10",
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--dry-run",
          "summary",
          "--engine",
          "browser",
          "--prompt",
          "Integration dry run",
          "--file",
          testFile,
          "--max-file-size-bytes",
          "128",
        ],
        { env },
      );

      expect(stdout).toContain("[preview]");
      expect(stdout).toContain("includes 1 inline file");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );
});
