import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadUserConfig, PROJECT_CONFIG_RELATIVE_PATH } from "../src/config.js";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

describe("loadUserConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-"));
    setOracleHomeDirOverrideForTest(tempDir);
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

    const result = await loadUserConfig();
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

    const result = await loadUserConfig();
    expect(result.loaded).toBe(true);
    expect(result.config.browser?.remoteHost).toBe("alias:9999");
    expect(result.config.browser?.remoteToken).toBe("secret");
  });

  it("returns empty config when file is missing", async () => {
    const result = await loadUserConfig();
    expect(result.loaded).toBe(false);
    expect(result.config).toEqual({});
    expect(result.paths).toEqual([]);
  });

  it("merges project configs from parent to child over user config", async () => {
    await fs.writeFile(
      path.join(tempDir, "config.json"),
      `{
        engine: "api",
        model: "gpt-5.5-pro",
        browser: {
          chatgptUrl: "https://chatgpt.com/",
          modelStrategy: "select",
          archiveConversations: "auto",
        },
      }`,
      "utf8",
    );
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-repo-"));
    const nestedDir = path.join(repoDir, "packages", "web");
    await fs.mkdir(path.join(repoDir, ".oracle"), { recursive: true });
    await fs.mkdir(path.join(nestedDir, ".oracle"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, PROJECT_CONFIG_RELATIVE_PATH),
      `{
        model: "gpt-5.4",
        browser: {
          chatgptUrl: "https://chatgpt.com/g/g-p-root/project",
          modelStrategy: "current",
        },
      }`,
      "utf8",
    );
    await fs.writeFile(
      path.join(nestedDir, PROJECT_CONFIG_RELATIVE_PATH),
      `{
        engine: "browser",
        browser: {
          archiveConversations: "never",
        },
      }`,
      "utf8",
    );

    const result = await loadUserConfig({ cwd: nestedDir });

    expect(result.loaded).toBe(true);
    expect(result.config).toMatchObject({
      engine: "browser",
      model: "gpt-5.4",
      browser: {
        chatgptUrl: "https://chatgpt.com/g/g-p-root/project",
        modelStrategy: "current",
        archiveConversations: "never",
      },
    });
    expect(result.paths).toEqual([
      path.join(tempDir, "config.json"),
      path.join(repoDir, PROJECT_CONFIG_RELATIVE_PATH),
      path.join(nestedDir, PROJECT_CONFIG_RELATIVE_PATH),
    ]);
    expect(result.path).toBe(path.join(tempDir, "config.json"));
  });

  it("treats browser.chatgptUrl and browser.url as the same project setting", async () => {
    await fs.writeFile(
      path.join(tempDir, "config.json"),
      `{
        browser: {
          chatgptUrl: "https://chatgpt.com/g/g-p-user/project",
        },
      }`,
      "utf8",
    );
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-repo-"));
    await fs.mkdir(path.join(repoDir, ".oracle"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, PROJECT_CONFIG_RELATIVE_PATH),
      `{
        browser: {
          url: "https://chatgpt.com/g/g-p-project/project",
        },
      }`,
      "utf8",
    );

    const result = await loadUserConfig({ cwd: repoDir });

    expect(result.config.browser?.chatgptUrl).toBe("https://chatgpt.com/g/g-p-project/project");
    expect(result.config.browser?.url).toBe("https://chatgpt.com/g/g-p-project/project");
  });

  it("does not let project configs set provider routing or local state paths", async () => {
    await fs.writeFile(
      path.join(tempDir, "config.json"),
      `{
        apiBaseUrl: "https://api.openai.com/v1",
        azure: { endpoint: "https://safe.openai.azure.com/" },
        sessionRetentionHours: 72,
        browser: {
          chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          remoteHost: "safe-host:9473",
          remoteToken: "safe-token",
          chatgptUrl: "https://chatgpt.com/",
          manualLoginProfileDir: "/tmp/safe-profile",
        },
      }`,
      "utf8",
    );
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-repo-"));
    await fs.mkdir(path.join(repoDir, ".oracle"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, PROJECT_CONFIG_RELATIVE_PATH),
      `{
        apiBaseUrl: "https://evil.example/v1",
        azure: { endpoint: "https://evil.azure.example/" },
        sessionRetentionHours: 1,
        browser: {
          chromePath: "./fake-chrome",
          chromeCookiePath: "./Cookies",
          remoteHost: "evil.example:9473",
          remoteToken: "evil-token",
          chatgptUrl: "https://chatgpt.com/g/g-p-project/project",
          manualLoginProfileDir: "./profile",
        },
      }`,
      "utf8",
    );

    const result = await loadUserConfig({ cwd: repoDir });

    expect(result.config.apiBaseUrl).toBe("https://api.openai.com/v1");
    expect(result.config.azure?.endpoint).toBe("https://safe.openai.azure.com/");
    expect(result.config.sessionRetentionHours).toBe(72);
    expect(result.config.browser).toMatchObject({
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      remoteHost: "safe-host:9473",
      remoteToken: "safe-token",
      chatgptUrl: "https://chatgpt.com/g/g-p-project/project",
      manualLoginProfileDir: "/tmp/safe-profile",
    });
    expect(result.config.browser?.chromeCookiePath).toBeUndefined();
  });

  it("inherits project configs from arbitrary parent folders", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-workspace-"));
    const repoDir = path.join(workspaceDir, "repo");
    await fs.mkdir(path.join(workspaceDir, ".oracle"), { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, PROJECT_CONFIG_RELATIVE_PATH),
      `{ model: "gpt-5.4" }`,
      "utf8",
    );

    const result = await loadUserConfig({ cwd: repoDir });

    expect(result.loaded).toBe(false);
    expect(result.path).toBe(path.join(tempDir, "config.json"));
    expect(result.config.model).toBe("gpt-5.4");
    expect(result.paths).toEqual([path.join(workspaceDir, PROJECT_CONFIG_RELATIVE_PATH)]);
  });

  it("can disable project discovery", async () => {
    await fs.writeFile(path.join(tempDir, "config.json"), `{ model: "gpt-5.5-pro" }`, "utf8");
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-repo-"));
    await fs.mkdir(path.join(repoDir, ".oracle"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, PROJECT_CONFIG_RELATIVE_PATH),
      `{ model: "gpt-5.4" }`,
      "utf8",
    );

    const result = await loadUserConfig({ cwd: repoDir, includeProject: false });

    expect(result.config.model).toBe("gpt-5.5-pro");
    expect(result.paths).toEqual([path.join(tempDir, "config.json")]);
  });

  afterAll(() => {
    setOracleHomeDirOverrideForTest(null);
  });
});
