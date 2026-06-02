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

const MAX_STDIN_LINE_BYTES = 16 * 1024 * 1024;
const EOF_RESPONSE_IDLE_MS = 50;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createBlankLineFilteredStdin(stdin: Readable, onForwardedLine: () => void): Transform {
  let pending = Buffer.alloc(0);
  const filtered = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pending = pending.length > 0 ? Buffer.concat([pending, buffer]) : buffer;

        while (true) {
          const lineEnd = pending.indexOf(0x0a);
          if (lineEnd === -1) break;

          const line = pending.subarray(0, lineEnd);
          if (line.length > MAX_STDIN_LINE_BYTES) {
            throw new Error(`MCP stdio line exceeded ${MAX_STDIN_LINE_BYTES} bytes`);
          }

          const lineWithNewline = pending.subarray(0, lineEnd + 1);
          pending = pending.subarray(lineEnd + 1);

          // MCP stdio is JSON-per-line; blank terminal input should not be parsed as JSON.
          if (line.toString("utf8").replace(/\r$/, "").trim().length > 0) {
            onForwardedLine();
            this.push(lineWithNewline);
          }
        }

        if (pending.length > MAX_STDIN_LINE_BYTES) {
          throw new Error(`MCP stdio line exceeded ${MAX_STDIN_LINE_BYTES} bytes`);
        }

        callback();
      } catch (error) {
        callback(toError(error));
      }
    },
    flush(callback) {
      try {
        if (pending.length > MAX_STDIN_LINE_BYTES) {
          throw new Error(`MCP stdio line exceeded ${MAX_STDIN_LINE_BYTES} bytes`);
        }
        if (pending.toString("utf8").trim().length > 0) {
          onForwardedLine();
          this.push(pending);
        }
        pending = Buffer.alloc(0);
        callback();
      } catch (error) {
        callback(toError(error));
      }
    },
  });

  stdin.pipe(filtered);
  return filtered;
}

function isJsonRpcRequest(message: unknown): message is { id: string | number } {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    "method" in message &&
    typeof (message as { method: unknown }).method === "string"
  );
}

function isJsonRpcResponse(message: unknown): message is { id: string | number } {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    ("result" in message || "error" in message)
  );
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

  let forwardedLineCount = 0;
  const activeRequestIds = new Set<string | number>();
  const filteredStdin = createBlankLineFilteredStdin(process.stdin, () => {
    forwardedLineCount += 1;
  });
  const transport = new StdioServerTransport(filteredStdin, process.stdout);
  let inFlightSends = 0;
  let filteredInputEnded = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  transport.onmessage = (message) => {
    if (isJsonRpcRequest(message)) {
      activeRequestIds.add(message.id);
    }
  };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    inFlightSends += 1;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    try {
      await send(message);
    } finally {
      inFlightSends -= 1;
      if (isJsonRpcResponse(message)) {
        activeRequestIds.delete(message.id);
      }
      scheduleCloseAfterInputEnd();
    }
  };

  const scheduleCloseAfterInputEnd = () => {
    if (!filteredInputEnded || closeTimer) return;
    if (forwardedLineCount > 0 && (activeRequestIds.size > 0 || inFlightSends > 0)) return;

    closeTimer = setTimeout(resolveClosed, forwardedLineCount === 0 ? 0 : EOF_RESPONSE_IDLE_MS);
  };
  transport.onerror = (error) => {
    console.error("MCP transport error:", error);
  };
  let didClose = false;
  let resolveClosedPromise = () => {};
  const resolveClosed = () => {
    if (didClose) return;
    didClose = true;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    process.stdin.unpipe(filteredStdin);
    filteredStdin.destroy();
    resolveClosedPromise();
  };
  const closed = new Promise<void>((resolve) => {
    resolveClosedPromise = resolve;
    transport.onclose = resolveClosed;
    filteredStdin.once("end", () => {
      filteredInputEnded = true;
      scheduleCloseAfterInputEnd();
    });
    filteredStdin.once("close", () => {
      filteredInputEnded = true;
      scheduleCloseAfterInputEnd();
    });
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
