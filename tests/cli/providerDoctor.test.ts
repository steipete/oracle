import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

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
    "actively validates provider credentials without a prompt or session storage",
    async () => {
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-preflight-openai-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-preflight-gemini-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: "/dev/null",
      };

      const server = createServer((request, response) => {
        const authorized =
          request.headers.authorization === "Bearer sk-preflight-openai-key" ||
          request.headers["x-goog-api-key"] === "gk-preflight-gemini-key";
        response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
        response.end('{"data":[]}');
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--preflight",
          "--models",
          "gpt-5.4,gemini-3-pro",
          "--base-url",
          `http://127.0.0.1:${address.port}/v1`,
        ],
        { env },
      ).finally(() => new Promise<void>((resolve) => server.close(() => resolve())));

      expect(stdout).toContain("Provider preflight");
      expect(stdout).toContain("gpt-5.4: ok");
      expect(stdout).toContain("gemini-3-pro: ok");
      expect(stdout).toContain("key: OPENAI_API_KEY=sk-p");
      expect(stdout).toContain("key: GEMINI_API_KEY=gk-p");
      expect(stdout).not.toContain("Prompt is required");
      expect(stdout).not.toContain("sk-preflight-openai-key");
      expect(stdout).not.toContain("gk-preflight-gemini-key");
    },
    CLI_TIMEOUT,
  );

  test(
    "fails closed when the provider endpoint is malformed",
    async () => {
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-preflight-openai-key",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: "/dev/null",
      };

      await expect(
        execFileAsync(
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
            "--base-url",
            "not a url",
          ],
          { env },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringMatching(/gpt-5\.4: not ready[\s\S]*Credential validation failed/i),
      });
    },
    CLI_TIMEOUT,
  );

  test(
    "fails preflight when the configured credential is rejected",
    async () => {
      const server = createServer((_request, response) => {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":"invalid credential"}');
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");

      const env = {
        ...process.env,
        OPENAI_API_KEY: "sk-rejected-preflight-key",
        AZURE_OPENAI_ENDPOINT: "",
        ORACLE_HOME_DIR: "/dev/null",
      };
      const error = await execFileAsync(
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
          "--base-url",
          `http://127.0.0.1:${address.port}/v1`,
        ],
        { env },
      )
        .then(() => null)
        .catch((caught) => caught as { stdout?: string; code?: number })
        .finally(() => new Promise<void>((resolve) => server.close(() => resolve())));

      expect(error?.code).toBe(1);
      expect(error?.stdout).toContain("gpt-5.4: not ready");
      expect(error?.stdout).toContain("Credential validation failed (HTTP 401)");
      expect(error?.stdout).not.toContain("sk-rejected-preflight-key");
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
