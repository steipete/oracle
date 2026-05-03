import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { shouldStartMcpServerFromModule } from "../../src/mcp/server.js";

describe("oracle-mcp module startup guard", () => {
  it("starts only when the server module is the executed entrypoint", () => {
    const serverPath = "/repo/src/mcp/server.ts";
    expect(shouldStartMcpServerFromModule(pathToFileURL(serverPath).href, serverPath)).toBe(true);
  });

  it("does not start when imported by an oracle-mcp bin shim", () => {
    expect(
      shouldStartMcpServerFromModule(
        pathToFileURL("/repo/src/mcp/server.ts").href,
        "/Users/me/.nvm/versions/node/bin/oracle-mcp",
      ),
    ).toBe(false);
  });
});
