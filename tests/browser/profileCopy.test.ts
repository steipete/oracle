import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  classifyRsyncExitForTest,
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

  test.skipIf(process.platform === "win32")(
    "omits volatile session state while preserving authentication storage (#540)",
    async () => {
      const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
      const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
      tmpDirs.push(src, dest);
      await writeFile(
        path.join(src, "Local State"),
        JSON.stringify({ profile: { last_used: "Default" } }),
      );
      const volatile = ["Sessions", "Sessions_Encrypted", "Session Storage"];
      for (const directory of [...volatile, "Local Storage", "IndexedDB"]) {
        await mkdir(path.join(src, "Default", directory), { recursive: true });
        await writeFile(path.join(src, "Default", directory, "data"), "synthetic state");
      }
      await writeFile(path.join(src, "Default", "Cookies"), "synthetic cookies");
      await expect(copyChromeProfile(src, dest)).resolves.toBe("Default");
      for (const directory of volatile)
        await expect(stat(path.join(dest, "Default", directory))).rejects.toThrow();
      for (const file of ["Local Storage/data", "IndexedDB/data", "Cookies"])
        await expect(readFile(path.join(dest, "Default", file), "utf8")).resolves.toMatch(
          /synthetic/,
        );
      await expect(readFile(path.join(dest, "Local State"), "utf8")).resolves.toMatch(/Default/);
    },
  );

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rejects genuine partial authentication copies and cleans the destination (#540)",
    async () => {
      const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-unreadable-"));
      const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
      tmpDirs.push(src, dest);
      await mkdir(path.join(src, "Default"));
      await writeFile(path.join(src, "Local State"), "{}");
      await writeFile(path.join(src, "Default", "Cookies"), "synthetic cookies");
      await chmod(path.join(src, "Default", "Cookies"), 0);
      await expect(copyChromeProfile(src, dest)).rejects.toThrow(/exit 23/);
      await expect(stat(dest)).rejects.toThrow();
    },
  );

  const fakeRsync = async (dir: string, body: string): Promise<() => void> => {
    const script = path.join(dir, "rsync");
    await writeFile(script, `#!/usr/bin/env node\n${body}\n`);
    await chmod(script, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${previous}`;
    return () => {
      process.env.PATH = previous;
    };
  };

  test.skipIf(process.platform === "win32")(
    "tolerates a vanished-file exit 23 (openrsync) and keeps the copied profile (#550)",
    async () => {
      const fakeBin = await mkdtemp(path.join(os.tmpdir(), "oracle-fakersync-"));
      const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
      const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
      tmpDirs.push(fakeBin, src, dest);
      // Emits openrsync's vanished-file diagnostic and exits 23 after copying.
      const restorePath = await fakeRsync(
        fakeBin,
        `const fs=require('fs'),a=process.argv.slice(2),dst=a[a.length-1],src=a[a.length-2];
        fs.cpSync(src,dst,{recursive:true});
        console.error('rsync(1): error: '+src+'volatile.tmp: open (2) in '+src+': No such file or directory');
        process.exit(23);`,
      );
      await writeFile(path.join(src, "Local State"), "{}");
      await mkdir(path.join(src, "Default"));
      await writeFile(path.join(src, "Default", "Cookies"), "synthetic cookies");
      try {
        await expect(copyChromeProfile(src, dest)).resolves.toBe("Default");
        await expect(readFile(path.join(dest, "Default", "Cookies"), "utf8")).resolves.toMatch(
          /synthetic cookies/,
        );
      } finally {
        restorePath();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a vanished-file exit 23 when auth storage did not survive (#550)",
    async () => {
      const fakeBin = await mkdtemp(path.join(os.tmpdir(), "oracle-fakersync-"));
      const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
      const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
      tmpDirs.push(fakeBin, src, dest);
      // Copies nothing but reports a vanished file: the Cookies that existed in
      // the source cannot land in the destination, so the copy must be refused.
      const restorePath = await fakeRsync(
        fakeBin,
        `const a=process.argv.slice(2),src=a[a.length-2];
        console.error('rsync(1): error: '+src+'Default/Cookies: open (2) in '+src+': No such file or directory');
        process.exit(23);`,
      );
      await writeFile(path.join(src, "Local State"), "{}");
      await mkdir(path.join(src, "Default"));
      await writeFile(path.join(src, "Default", "Cookies"), "synthetic cookies");
      try {
        await expect(copyChromeProfile(src, dest)).rejects.toThrow(/missing "Cookies"/);
        await expect(stat(dest)).rejects.toThrow();
      } finally {
        restorePath();
      }
    },
  );

  test("classifies rsync exits: 23 is tolerated only for vanished-only stderr (#550)", () => {
    expect(classifyRsyncExitForTest(0, "")).toBe("ok");
    expect(classifyRsyncExitForTest(24, "")).toBe("ok");
    expect(
      classifyRsyncExitForTest(
        23,
        "rsync(1): error: /p/f.tmp: open (2) in /p: No such file or directory\n",
      ),
    ).toBe("ok");
    expect(
      classifyRsyncExitForTest(
        23,
        'rsync: link_stat "/p/f.tmp" failed: No such file or directory (2)\n' +
          "rsync error: some files/attrs were not transferred (see previous errors) (code 23)\n",
      ),
    ).toBe("ok");
    expect(
      classifyRsyncExitForTest(
        23,
        "rsync(1): error: /p/Cookies: open (2) in /p: Permission denied\n",
      ),
    ).toBe("fatal");
    expect(classifyRsyncExitForTest(23, "")).toBe("fatal");
    expect(
      classifyRsyncExitForTest(
        23,
        "rsync(1): error: /p/a: open (2) in /p: No such file or directory\n" +
          "rsync(1): error: /p/b: open (2) in /p: Permission denied\n",
      ),
    ).toBe("fatal");
    for (const name of ["vanished.txt", "partial transfer", "No such file or directory"]) {
      expect(
        classifyRsyncExitForTest(
          23,
          `rsync(1): error: /p/${name}: open (2) in /p: Permission denied`,
        ),
      ).toBe("fatal");
      expect(
        classifyRsyncExitForTest(
          23,
          `rsync(1): error: /p/volatile: open (2) in /p: No such file or directory\nrsync(1): error: /p/${name}: open (2) in /p: Permission denied`,
        ),
      ).toBe("fatal");
    }
    expect(classifyRsyncExitForTest(1, "anything")).toBe("fatal");
  });
});
