import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadUserConfig, writeUserConfig } from "../src/config.js";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

describe("loadUserConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-"));
    setOracleHomeDirOverrideForTest(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("parses JSON5 config with comments", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      `// comment\n{
        engine: "browser",
        notify: { sound: true },
        heartbeatSeconds: 15,
        maxFileSizeBytes: 2097152,
        browser: { remoteHost: "host:1234", remoteToken: "abc" },
      }`,
      "utf8",
    );

    const result = await loadUserConfig({ env: {} as NodeJS.ProcessEnv });
    expect(result.loaded).toBe(true);
    expect(result.config.engine).toBe("browser");
    expect(result.config.notify?.sound).toBe(true);
    expect(result.config.heartbeatSeconds).toBe(15);
    expect(result.config.maxFileSizeBytes).toBe(2097152);
    expect(result.config.browser?.remoteHost).toBe("host:1234");
    expect(result.config.browser?.remoteToken).toBe("abc");
  });

  it("supports browser remote defaults", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      `{
        browser: { remoteHost: "alias:9999", remoteToken: "secret" }
      }`,
      "utf8",
    );

    const result = await loadUserConfig({ env: {} as NodeJS.ProcessEnv });
    expect(result.loaded).toBe(true);
    expect(result.config.browser?.remoteHost).toBe("alias:9999");
    expect(result.config.browser?.remoteToken).toBe("secret");
  });

  it("returns empty config when file is missing", async () => {
    const result = await loadUserConfig({ env: {} as NodeJS.ProcessEnv });
    expect(result.loaded).toBe(false);
    expect(result.config).toEqual({});
  });

  it("lets environment values override matching JSON config keys", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      `{
        engine: "browser",
        browser: { remoteHost: "config:9473", remoteToken: "config-token" }
      }`,
      "utf8",
    );

    const result = await loadUserConfig({
      env: {
        ORACLE_ENGINE: "api",
        ORACLE_REMOTE_HOST: "env:9473",
        ORACLE_REMOTE_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
    });

    expect(result.loaded).toBe(true);
    expect(result.config.engine).toBe("api");
    expect(result.config.browser?.remoteHost).toBe("env:9473");
    expect(result.config.browser?.remoteToken).toBe("env-token");
  });

  it("ignores blank environment values instead of shadowing JSON config", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      `{ engine: "browser", browser: { remoteHost: "config:9473" } }`,
      "utf8",
    );

    const result = await loadUserConfig({
      env: { ORACLE_ENGINE: "  ", ORACLE_REMOTE_HOST: "  " } as NodeJS.ProcessEnv,
    });

    expect(result.config.engine).toBe("browser");
    expect(result.config.browser?.remoteHost).toBe("config:9473");
  });

  it("rejects non-object config content and falls back to empty config", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await fs.writeFile(path.join(tempDir, "config.json"), "true", "utf8");

    const result = await loadUserConfig({ env: {} as NodeJS.ProcessEnv });

    expect(result.loaded).toBe(false);
    expect(result.config).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Expected .* to contain a JSON object/));
  });

  it("writes config atomically into a newly created directory", async () => {
    const target = path.join(tempDir, "nested", "config.json");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeUserConfig({ model: `model-${index}` }, target),
      ),
    );

    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as { model?: string };
    expect(parsed.model).toMatch(/^model-\d$/);

    const entries = await fs.readdir(path.dirname(target));
    expect(entries.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  afterAll(() => {
    setOracleHomeDirOverrideForTest(null);
  });
});
