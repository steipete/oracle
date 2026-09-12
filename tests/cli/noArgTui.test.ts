import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/cli/tui/index.js", () => ({
  launchTui: vi.fn().mockResolvedValue(undefined),
}));

const launchTuiMock = vi.mocked(await import("../../src/cli/tui/index.js")).launchTui as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("zero-arg TUI entry", () => {
  test("shows help when no args (no TUI)", async () => {
    const originalArgv = process.argv;
    const originalTty = process.stdout.isTTY;
    process.argv = ["node", "bin/oracle-cli.js"]; // mimics zero-arg user input
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    await import("../../bin/oracle-cli.js");

    // Commander wires the action async; poll briefly to avoid flakiness on slower runners.
    for (let i = 0; i < 10 && launchTuiMock.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(launchTuiMock).not.toHaveBeenCalled();

    // restore
    process.argv = originalArgv;
    Object.defineProperty(process.stdout, "isTTY", { value: originalTty, configurable: true });
  }, 15_000);

  test("invokes launchTui via subcommand", async () => {
    const originalArgv = process.argv;
    const originalTty = process.stdout.isTTY;
    process.argv = ["node", "bin/oracle-cli.js", "tui"];
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    try {
      await import("../../bin/oracle-cli.js");
      await vi.waitFor(() => expect(launchTuiMock).toHaveBeenCalled(), { timeout: 5_000 });
    } finally {
      process.argv = originalArgv;
      Object.defineProperty(process.stdout, "isTTY", { value: originalTty, configurable: true });
    }
  }, 15_000);
});
