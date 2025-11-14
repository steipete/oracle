#!/usr/bin/env bun
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const child = spawn(process.execPath, ['./bin/oracle.js', ...args], {
  stdio: 'inherit',
});
child.on('exit', (code) => {
  process.exit(code ?? 0);
});
