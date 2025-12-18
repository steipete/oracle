import chalk from 'chalk';
import { loadUserConfig } from '../../config.js';
import { resolveRemoteServiceConfig } from '../../remote/remoteServiceConfig.js';

export interface BridgeCodexConfigCliOptions {
  printToken?: boolean;
}

export async function runBridgeCodexConfig(options: BridgeCodexConfigCliOptions): Promise<void> {
  const { config: userConfig } = await loadUserConfig();
  const resolved = resolveRemoteServiceConfig({
    cliHost: undefined,
    cliToken: undefined,
    userConfig,
    env: process.env,
  });

  const snippet = formatCodexMcpSnippet({
    remoteHost: resolved.host,
    remoteToken: resolved.token,
    includeToken: Boolean(options.printToken),
  });

  console.log(snippet);
  if (!options.printToken) {
    console.log('');
    console.log(chalk.dim('Tip: rerun with --print-token to include ORACLE_REMOTE_TOKEN in the snippet.'));
  }
}

export function formatCodexMcpSnippet({
  remoteHost,
  remoteToken,
  includeToken,
}: {
  remoteHost?: string;
  remoteToken?: string;
  includeToken: boolean;
}): string {
  const hostValue = remoteHost ?? '127.0.0.1:9473';
  const tokenValue = includeToken ? remoteToken ?? '<YOUR_TOKEN>' : '<YOUR_TOKEN>';

  return [
    '# ~/.codex/config.toml',
    '',
    '[mcp.servers.oracle]',
    'command = "oracle-mcp"',
    'args = []',
    `env = { ORACLE_ENGINE = "browser", ORACLE_REMOTE_HOST = "${escapeTomlString(hostValue)}", ORACLE_REMOTE_TOKEN = "${escapeTomlString(tokenValue)}" }`,
    '',
    '# If you prefer npx:',
    '# [mcp.servers.oracle]',
    '# command = "npx"',
    '# args = ["-y", "@steipete/oracle", "oracle-mcp"]',
    `# env = { ORACLE_ENGINE = "browser", ORACLE_REMOTE_HOST = "${escapeTomlString(hostValue)}", ORACLE_REMOTE_TOKEN = "${escapeTomlString(tokenValue)}" }`,
  ].join('\n');
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

