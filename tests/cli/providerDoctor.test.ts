import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");
const CLI_TIMEOUT = 15_000;

describe("provider doctor CLI", () => {
  test(
    "prints redacted provider readiness without a prompt",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-doctor-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-doctor-openai-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-doctor-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "doctor",
          "--providers",
          "--model",
          "gpt-5.4",
          "--provider",
          "openai",
        ],
        { env },
      );

      expect(stdout).toContain("Provider readiness");
      expect(stdout).toContain("gpt-5.4: ok");
      expect(stdout).toContain("provider: OpenAI");
      expect(stdout).toContain("key: OPENAI_API_KEY=sk-d");
      expect(stdout).toContain("azure: ignored");
      expect(stdout).not.toContain("sk-doctor-openai-key");

      await rm(oracleHome, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "prints a route plan from the root command without a prompt",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-route-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-route-openai-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--route", "--model", "gpt-5.4", "--provider", "openai"],
        { env },
      );

      expect(stdout).toContain("Route plan");
      expect(stdout).toContain("gpt-5.4: ok");
      expect(stdout).toContain("provider: OpenAI");
      expect(stdout).toContain("azure: ignored");
      expect(stdout).not.toContain("sk-route-openai-key");

      await rm(oracleHome, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "prints a route plan without initializing session storage",
    async () => {
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-route-openai-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-route-gemini-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: "/dev/null",
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--route", "--model", "gpt-5.4", "--provider", "openai"],
        { env },
      );

      expect(stdout).toContain("Route plan");
      expect(stdout).toContain("gpt-5.4: ok");
      expect(stdout).toContain("provider: OpenAI");
    },
    CLI_TIMEOUT,
  );

  test(
    "root route models ignore configured default model",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-route-models-config-"));
      await mkdir(oracleHome, { recursive: true });
      await writeFile(path.join(oracleHome, "config.json"), JSON.stringify({ model: "gpt-5.1" }));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-route-openai-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--route", "--models", "gpt-5.4,gemini-3-pro"],
        { env },
      );

      expect(stdout).toContain("gpt-5.4: ok");
      expect(stdout).toContain("gemini-3-pro: ok");
      expect(stdout).not.toContain("gpt-5.1");

      await rm(oracleHome, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "prints machine-parseable provider JSON without the banner",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-doctor-json-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-doctor-json-openai-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "doctor", "--providers", "--json", "--model", "gpt-5.4"],
        { env },
      );

      expect(stdout.trimStart().startsWith("{")).toBe(true);
      expect(stdout).not.toContain("🧿 oracle");
      const parsed = JSON.parse(stdout) as { providers: Array<{ model: string; ok: boolean }> };
      expect(parsed.providers).toEqual([expect.objectContaining({ model: "gpt-5.4", ok: true })]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "keeps provider JSON parseable with root flags before the subcommand",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-doctor-json-leading-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-doctor-json-openai-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--provider",
          "openai",
          "doctor",
          "--providers",
          "--json",
          "--model",
          "gpt-5.4",
        ],
        { env },
      );

      expect(stdout.trimStart().startsWith("{")).toBe(true);
      expect(stdout).not.toContain("🧿 oracle");
      const parsed = JSON.parse(stdout) as { providers: Array<{ model: string; ok: boolean }> };
      expect(parsed.providers).toEqual([expect.objectContaining({ model: "gpt-5.4", ok: true })]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "provider doctor falls back to Azure config when env endpoint is empty",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-doctor-azure-config-"));
      await mkdir(oracleHome, { recursive: true });
      await writeFile(
        path.join(oracleHome, "config.json"),
        JSON.stringify({
          azure: {
            endpoint: "https://configured-resource.openai.azure.com/",
            deployment: "gpt-prod",
          },
        }),
      );
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-config-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "doctor", "--providers", "--model", "gpt-5.4"],
        { env },
      );

      expect(stdout).toContain("gpt-5.4: ok");
      expect(stdout).toContain("provider: Azure OpenAI");
      expect(stdout).toContain("base: configured-resource.openai.azure.com");
      expect(stdout).toContain("azure deployment: gpt-prod");

      await rm(oracleHome, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "root route prints forced Azure readiness instead of throwing raw validation",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-route-azure-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-route-openai-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
      };

      let stdout = "";
      try {
        await execFileAsync(
          process.execPath,
          ["--import", "tsx", CLI_ENTRY, "--route", "--provider", "azure", "--model", "gpt-5.4"],
          { env },
        );
      } catch (error) {
        stdout = (error as { stdout?: string }).stdout ?? "";
      }

      expect(stdout).toContain("Route plan");
      expect(stdout).toContain("gpt-5.4: not ready");
      expect(stdout).toContain("provider: Azure OpenAI");
      expect(stdout).toContain("--provider azure requires --azure-endpoint");

      await rm(oracleHome, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );

  test(
    "root route falls back to Azure config when env endpoint is empty",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-route-azure-config-"));
      await mkdir(oracleHome, { recursive: true });
      await writeFile(
        path.join(oracleHome, "config.json"),
        JSON.stringify({
          azure: {
            endpoint: "https://configured-resource.openai.azure.com/",
            deployment: "gpt-prod",
          },
        }),
      );
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-config-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--route", "--model", "gpt-5.4"],
        { env },
      );

      expect(stdout).toContain("Route plan");
      expect(stdout).toContain("gpt-5.4: ok");
      expect(stdout).toContain("provider: Azure OpenAI");
      expect(stdout).toContain("base: configured-resource.openai.azure.com");
      expect(stdout).toContain("azure deployment: gpt-prod");

      await rm(oracleHome, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );
});
