import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  copyChromeProfile,
  resolveChromeProfileDirectoryForTest,
} from "../../src/browser/profileCopy.js";

describe("copyChromeProfile", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tmpDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  });

  test("fails fast when the required Local State file cannot be copied", async () => {
    const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
    tmpDirs.push(dest);
    // A source dir without a `Local State` file must fail loudly, not continue with a
    // profile that will later look unauthenticated.
    const srcWithoutLocalState = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
    tmpDirs.push(srcWithoutLocalState);

    await expect(copyChromeProfile(srcWithoutLocalState, dest)).rejects.toThrow(/Local State/);
    await expect(stat(dest)).rejects.toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "copies the active Local State profile instead of assuming Default",
    async () => {
      const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
      const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
      tmpDirs.push(src, dest);
      await mkdir(path.join(src, "Profile 2"), { recursive: true });
      await mkdir(path.join(src, "Default"), { recursive: true });
      await writeFile(
        path.join(src, "Local State"),
        JSON.stringify({ profile: { last_used: "Profile 2" } }),
      );
      await writeFile(path.join(src, "Profile 2", "Cookies"), "active-session");
      await writeFile(path.join(src, "Default", "Cookies"), "wrong-session");

      await expect(copyChromeProfile(src, dest)).resolves.toBe("Profile 2");
      await expect(readFile(path.join(dest, "Profile 2", "Cookies"), "utf8")).resolves.toBe(
        "active-session",
      );
      await expect(stat(path.join(dest, "Default"))).rejects.toThrow();
    },
  );

  test("accepts an explicit direct-child profile and rejects nested paths", () => {
    const localState = JSON.stringify({ profile: { last_used: "Profile 2" } });
    expect(
      resolveChromeProfileDirectoryForTest("/tmp/chrome", localState, "/tmp/chrome/Profile 4"),
    ).toBe("Profile 4");
    expect(() =>
      resolveChromeProfileDirectoryForTest("/tmp/chrome", localState, "Profile 4/Cookies"),
    ).toThrow(/direct child/);
  });
});
