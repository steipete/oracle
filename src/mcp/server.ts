#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getCliVersion } from "../version.js";
import { registerConsultTool } from "./tools/consult.js";
import { registerSessionsTool } from "./tools/sessions.js";
import { registerSessionResources } from "./tools/sessionResources.js";
import { loadUserConfig } from "../config.js";

export async function startMcpServer(): Promise<void> {
  const { config: userConfig } = await loadUserConfig();

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

  registerConsultTool(server, { toolHint: userConfig.mcp?.toolHint });
  registerSessionsTool(server);
  registerSessionResources(server);

  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    console.error("MCP transport error:", error);
  };
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => {
      resolve();
    };
  });

  // Keep the process alive until the client closes the transport.
  await server.connect(transport);
  await closed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((error) => {
    console.error("Failed to start oracle-mcp:", error);
    process.exitCode = 1;
  });
}
