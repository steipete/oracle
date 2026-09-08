import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = path.join(process.cwd(), "dist/bin/oracle-mcp.js");

describe("oracle-mcp schemas", () => {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  const stderrLog: string[] = [];
  const exitLog: string[] = [];
  const parsedMessages: unknown[] = [];
  const parseErrors: string[] = [];
  let stdoutRemainder = "";

  // Keep the daemon quiet and skip optional native deps in CI.
  process.env.ORACLE_DISABLE_KEYTAR = "1";

  const attachStderr = (proc: ChildProcess | undefined): void => {
    proc?.stderr?.on("data", (chunk) => stderrLog.push(String(chunk)));
    proc?.stdout?.on("data", (chunk) => {
      exitLog.push(`stdout: ${String(chunk)}`);
      stdoutRemainder += String(chunk);
      const lines = stdoutRemainder.split("\n");
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          parsedMessages.push(msg);
        } catch (error) {
          parseErrors.push(`parse error for line "${line}": ${String(error)}`);
        }
      }
    });
    proc?.on("exit", (code, signal) =>
      exitLog.push(`exit ${code ?? "null"} signal ${signal ?? "null"}`),
    );
    proc?.on("error", (err) => exitLog.push(`error ${String(err)}`));
  };

  beforeAll(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidateClient = new Client({ name: "schema-smoke", version: "0.0.0" });
      const candidateTransport = new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        stderr: "pipe",
        cwd: path.dirname(entry),
        env: {
          ...process.env,
          // biome-ignore lint/style/useNamingConvention: environment variables stay upper snake case
          ORACLE_DISABLE_KEYTAR: "1",
        },
      });
      try {
        await candidateClient.connect(candidateTransport);
        const proc = (candidateTransport as unknown as { proc?: ChildProcess }).proc;
        attachStderr(proc);
        client = candidateClient;
        transport = candidateTransport;
        return;
      } catch (error) {
        lastError = error;
        const proc = (candidateTransport as unknown as { proc?: ChildProcess }).proc;
        attachStderr(proc);
        proc?.kill?.("SIGKILL");
        await candidateClient.close().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const detail = [...stderrLog, ...exitLog].join("") || String(lastError);
    throw new Error(`oracle-mcp failed to start: ${detail}`);
  }, 20_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    const proc = (transport as unknown as { proc?: ChildProcess })?.proc;
    proc?.kill?.("SIGKILL");
  });

  it("exposes object schemas for tools", async () => {
    if (!client) throw new Error("MCP client not connected");
    const { tools } = await client.listTools({}, { timeout: 10_000 });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name)).toContain("wait");
    for (const tool of tools) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        if (!schema) continue;
        expect(schema.type).toBe("object");
      }
    }
  });

  it("emits only JSON-RPC lines on stdout during handshake", async () => {
    // Give the transport a moment to flush handshake traffic.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(parseErrors).toHaveLength(0);
    if (parsedMessages.length > 0) {
      for (const msg of parsedMessages) {
        expect((msg as { jsonrpc?: unknown }).jsonrpc).toBe("2.0");
      }
    }
    expect(stdoutRemainder.trim()).toBe("");
  });
});
