#!/usr/bin/env node
import { startMcpServer } from '../src/mcp/server.js';

startMcpServer().catch((error) => {
  console.error('oracle-mcp exited with an error:', error);
  process.exitCode = 1;
});
