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
    },
  },
});
