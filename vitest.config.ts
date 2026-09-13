import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    setupFiles: ["tests/setup-env.ts", "tests/cli/runOracle/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Include covered and uncovered TypeScript sources.
      include: ["src/**/*.ts"],
      // Exclude interactive/IPC entrypoints that aren’t practical to unit test.
      exclude: [
        "src/cli/tui/**",
        "src/remote/**",
        "src/mcp/**",
        "src/browser/actions/**",
        "src/browser/index.ts",
        "src/browser/pageActions.ts",
        "src/browser/chromeLifecycle.ts",
        "src/browserMode.ts",
        "src/oracle.ts",
        "src/oracle/modelRunner.ts",
        "src/oracle/stringifier.ts",
        "src/oracle/types.ts",
        "src/types/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@src": fileURLToPath(new URL("./src", import.meta.url)),
      "@tests": fileURLToPath(new URL("./tests", import.meta.url)),
    },
  },
});
