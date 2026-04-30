import { describe, expect, test } from "vitest";
import { formatClaudeMcpConfig } from "../../src/cli/bridge/claudeConfig.ts";

describe("formatClaudeMcpConfig", () => {
  test("prints a remote Claude Code MCP config without exposing tokens by default", () => {
    const parsed = JSON.parse(
      formatClaudeMcpConfig({
        oracleHomeDir: "/Users/test/.oracle-local",
        browserProfileDir: "/Users/test/.oracle-local/browser-profile",
        remoteHost: "127.0.0.1:9473",
        remoteToken: "secret-token",
        includeToken: false,
      }),
    );

    expect(parsed.mcpServers.oracle).toMatchObject({
      type: "stdio",
      command: "oracle-mcp",
      args: [],
    });
    expect(parsed.mcpServers.oracle.env).toMatchObject({
      ORACLE_ENGINE: "browser",
      ORACLE_HOME_DIR: "/Users/test/.oracle-local",
      ORACLE_BROWSER_PROFILE_DIR: "/Users/test/.oracle-local/browser-profile",
      ORACLE_REMOTE_HOST: "127.0.0.1:9473",
      ORACLE_REMOTE_TOKEN: "<YOUR_TOKEN>",
    });
  });

  test("prints a local-browser Claude Code MCP config without remote bridge env", () => {
    const parsed = JSON.parse(
      formatClaudeMcpConfig({
        oracleHomeDir: "/Users/test/.oracle",
        browserProfileDir: "/Users/test/.oracle/browser-profile",
        remoteHost: "127.0.0.1:9473",
        remoteToken: "secret-token",
        includeToken: true,
        localBrowser: true,
      }),
    );

    expect(parsed.mcpServers.oracle.env).toEqual({
      ORACLE_ENGINE: "browser",
      ORACLE_HOME_DIR: "/Users/test/.oracle",
      ORACLE_BROWSER_PROFILE_DIR: "/Users/test/.oracle/browser-profile",
    });
  });
});
