import { describe, expect, test } from "vitest";
import { splitShellLikeArgs } from "../../src/cli/args.js";
import { assertNoConflictingCommandFlags } from "../../src/cli/commands.js";
import { runBridgeHost } from "../../src/cli/bridge/host.js";

describe("bridge host CLI argument handling", () => {
  test("splits ssh extra args without invoking shell expansion", () => {
    expect(
      splitShellLikeArgs(String.raw`-o ServerAliveInterval=15 -J "jump host" -i key\ file`, {
        optionName: "--ssh-extra-args",
      }),
    ).toEqual(["-o", "ServerAliveInterval=15", "-J", "jump host", "-i", "key file"]);
  });

  test("rejects malformed ssh extra args instead of silently changing argv", () => {
    expect(() =>
      splitShellLikeArgs(`-o "ProxyJump=bastion`, { optionName: "--ssh-extra-args" }),
    ).toThrow(/--ssh-extra-args has an unterminated double quote/);
    expect(() =>
      splitShellLikeArgs("-i key\\", { optionName: "--ssh-extra-args" }),
    ).toThrow(/--ssh-extra-args ends with an unfinished escape/);
  });

  test("rejects conflicting command mode flags", () => {
    expect(() =>
      assertNoConflictingCommandFlags(
        [
          { name: "--background", selected: true },
          { name: "--foreground", selected: true },
        ],
        "bridge host",
      ),
    ).toThrow(/Cannot combine --background and --foreground for bridge host/);
  });

  test("bridge host rejects background and foreground together before starting services", async () => {
    await expect(runBridgeHost({ background: true, foreground: true })).rejects.toThrow(
      /Cannot combine --background and --foreground for bridge host/,
    );
  });
});
