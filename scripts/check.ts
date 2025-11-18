#!/usr/bin/env bun
import process from 'node:process';

type BunBuildConfig = {
  entrypoints: string[];
  outdir?: string;
  target?: string;
  minify?: boolean;
  write?: boolean;
  sourcemap?: 'inline' | 'external' | 'none';
};

const buildConfig: BunBuildConfig = {
  entrypoints: ['./bin/oracle-cli.js'],
  outdir: './.bun-check',
  target: 'bun',
  minify: false,
  write: false,
};

const result = await Bun.build(buildConfig);

if (!result.success) {
  console.error('Build failed while checking syntax:');
  for (const log of result.logs) {
    console.error(log.message);
    if (log.position) {
      console.error(`\tat ${log.position.file}:${log.position.line}:${log.position.column}`);
    }
  }
  process.exit(1);
}

console.log('Syntax OK');
