#!/usr/bin/env node
import { Buffer } from "node:buffer";
import "dotenv/config";
import process from "node:process";
import { Transform, type Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getCliVersion } from "../version.js";
import { registerConsultTool } from "./tools/consult.js";
import { registerProjectSourcesTool } from "./tools/projectSources.js";
import { registerSessionsTool } from "./tools/sessions.js";
import { registerSessionResources } from "./tools/sessionResources.js";

function createBlankLineFilteredStdin(stdin: Readable): Transform {
  let pending = Buffer.alloc(0);
  const filtered = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = pending.length > 0 ? Buffer.concat([pending, buffer]) : buffer;

      while (true) {
        const lineEnd = pending.indexOf(0x0a);
        if (lineEnd === -1) break;

        const line = pending.subarray(0, lineEnd);
        const lineWithNewline = pending.subarray(0, lineEnd + 1);
        pending = pending.subarray(lineEnd + 1);

        // MCP stdio is JSON-per-line; blank terminal input should not be parsed as JSON.
        if (line.toString("utf8").replace(/\r$/, "").trim().length > 0) {
          this.push(lineWithNewline);
        }
      }

      callback();
    },
    flush(callback) {
      if (pending.toString("utf8").trim().length > 0) {
        this.push(pending);
      }
      pending = Buffer.alloc(0);
      callback();
    },
  });

  stdin.pipe(filtered);
  return filtered;
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    {
      name: "oracle-mcp",
      version: getCliVersion(),
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  registerConsultTool(server);
  registerProjectSourcesTool(server);
  registerSessionsTool(server);
  registerSessionResources(server);

  const stdin = createBlankLineFilteredStdin(process.stdin);
  const transport = new StdioServerTransport(stdin, process.stdout);
  transport.onerror = (error) => {
    console.error("MCP transport error:", error);
  };
  const closed = new Promise<void>((resolve) => {
    let didClose = false;
    const resolveClosed = () => {
      if (didClose) return;
      didClose = true;
      process.stdin.unpipe(stdin);
      stdin.destroy();
      resolve();
    };
    transport.onclose = resolveClosed;
    stdin.once("end", resolveClosed);
    stdin.once("close", resolveClosed);
  });

  // Keep the process alive until the client closes the transport.
  await server.connect(transport);
  await closed;
}

export function shouldStartMcpServerFromModule(
  moduleUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): boolean {
  return argv1 ? moduleUrl === pathToFileURL(argv1).href : false;
}

if (shouldStartMcpServerFromModule()) {
  startMcpServer().catch((error) => {
    console.error("Failed to start oracle-mcp:", error);
    process.exitCode = 1;
  });
}
