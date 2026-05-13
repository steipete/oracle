import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureOracleHomeDir,
  getOracleHomeDir,
  setOracleHomeDirOverrideForTest,
} from "../src/oracleHome.js";

const originalOracleHome = process.env.ORACLE_HOME_DIR;

describe("oracle home resolution", () => {
  afterEach(() => {
    setOracleHomeDirOverrideForTest(null);
    if (originalOracleHome === undefined) {
      delete process.env.ORACLE_HOME_DIR;
    } else {
      process.env.ORACLE_HOME_DIR = originalOracleHome;
    }
  });

  it("ignores blank ORACLE_HOME_DIR instead of using the current directory", () => {
    process.env.ORACLE_HOME_DIR = "   ";
    expect(getOracleHomeDir()).toBe(path.join(os.homedir(), ".oracle"));
  });

  it("normalizes relative overrides to absolute paths", () => {
    setOracleHomeDirOverrideForTest("relative-oracle-home");
    expect(getOracleHomeDir()).toBe(path.resolve("relative-oracle-home"));
  });

  it("creates the oracle home directory with private permissions", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-home-test-"));
    const home = path.join(tempRoot, "missing", "home");
    setOracleHomeDirOverrideForTest(home);

    await expect(ensureOracleHomeDir()).resolves.toBe(home);
    const stat = await fs.stat(home);
    expect(stat.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o700);
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});
