#!/usr/bin/env npx tsx
/**
 * POC: Test connecting to remote Chrome instance
 *
 * On remote machine with display, run:
 *   google-chrome --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0
 *
 * Then run this script:
 *   npx tsx scripts/test-remote-chrome.ts <remote-host> [port]
 */

import CDP from 'chrome-remote-interface';

async function main() {
  const host = process.argv[2] || 'localhost';
  const port = parseInt(process.argv[3] || '9222', 10);

  console.log(`Attempting to connect to Chrome at ${host}:${port}...`);

  try {
    // Test connection
    const client = await CDP({ host, port });
    console.log('✓ Connected to Chrome DevTools Protocol');

    const { Network, Page, Runtime } = client;

    // Enable domains
    await Promise.all([Network.enable(), Page.enable()]);
    console.log('✓ Enabled Network and Page domains');

    // Get browser version info
    const version = await CDP.Version({ host, port });
    console.log(`✓ Browser: ${version.Browser}`);
    console.log(`✓ Protocol: ${version['Protocol-Version']}`);

    // Navigate to ChatGPT
    console.log('\nNavigating to ChatGPT...');
    await Page.navigate({ url: 'https://chatgpt.com/' });
    await Page.loadEventFired();
    console.log('✓ Page loaded');

    // Check current URL
    const evalResult = await Runtime.evaluate({ expression: 'window.location.href' });
    console.log(`✓ Current URL: ${evalResult.result.value}`);

    // Check if logged in (look for specific elements)
    const checkLogin = await Runtime.evaluate({
      expression: `
        // Check for composer textarea (indicates logged in)
        const composer = document.querySelector('textarea, [contenteditable="true"]');
        const hasComposer = !!composer;

        // Check for login button (indicates logged out)
        const loginBtn = document.querySelector('a[href*="login"], button[data-testid*="login"]');
        const hasLogin = !!loginBtn;

        ({ hasComposer, hasLogin, loggedIn: hasComposer && !hasLogin })
      `,
    });
    console.log(`✓ Login status: ${JSON.stringify(checkLogin.result.value)}`);

    await client.close();
    console.log('\n✓ POC successful! Remote Chrome connection works.');
    console.log('\nTo use Oracle with remote Chrome, you would need to:');
    console.log('1. Ensure cookies are loaded in remote Chrome');
    console.log('2. Configure Oracle with --remote-chrome <host:port> to use this instance');
    console.log('3. Ensure Oracle skips local Chrome launch when --remote-chrome is specified');

  } catch (error) {
    console.error('✗ Connection failed:', error instanceof Error ? error.message : error);
    console.log('\nTroubleshooting:');
    console.log('1. Ensure Chrome is running on remote machine with:');
    console.log(`   google-chrome --remote-debugging-port=${port} --remote-debugging-address=0.0.0.0`);
    console.log('2. Check firewall allows connections to port', port);
    console.log('3. Verify network connectivity to', host);
    process.exit(1);
  }
}

main();
