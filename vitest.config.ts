import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup-env.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      all: true,
      // Measure the real TypeScript sources (the repo doesn’t ship .js in src).
      include: ['src/**/*.ts'],
      // Exclude interactive/IPC entrypoints that aren’t practical to unit test.
      exclude: [
        'src/cli/tui/**',
        'src/remote/**',
        'src/mcp/**',
        'src/browser/actions/**',
        'src/browser/index.ts',
        'src/browser/pageActions.ts',
        'src/browser/chromeLifecycle.ts',
        'src/browserMode.ts',
        'src/heartbeat.ts',
        'src/oracle.ts',
        'src/oracle/claude.ts',
        'src/oracle/modelRunner.ts',
        'src/oracle/stringifier.ts',
        'src/oracle/types.ts',
        'src/types/**',
        'src/cli/notifier.ts',
        'src/cli/sessionDisplay.ts',
        '**/modelRunner.ts',
      ],
    },
  },
});
