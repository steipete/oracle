import { describe, expect, test } from "vitest";
import {
  parseWslResolverHost,
  resolveWslChromeHost,
  resolveWslChromeLaunchRoute,
} from "../../src/browser/wslHost.js";

describe("WSL resolver host", () => {
  test.each(["127.0.0.53", "127.0.0.54", "127.12.34.56"])(
    "maps loopback resolver %s to local Chrome",
    (host) => {
      expect(parseWslResolverHost(`nameserver ${host}\n`)).toBe("127.0.0.1");
    },
  );

  test("preserves a non-loopback resolver host", () => {
    expect(parseWslResolverHost("nameserver 172.28.224.1\n")).toBe("172.28.224.1");
  });

  test("returns null when no IPv4 nameserver is present", () => {
    expect(parseWslResolverHost("search example.test\n")).toBeNull();
  });

  test("prefers the explicit remote-debug host over the legacy override and resolver", () => {
    expect(
      resolveWslChromeHost({
        remoteDebugHost: " 192.0.2.10 ",
        wslHostIp: "192.0.2.11",
        resolvConf: "nameserver 127.0.0.53\n",
      }),
    ).toBe("192.0.2.10");
  });

  test("preserves the legacy WSL host override", () => {
    expect(
      resolveWslChromeHost({
        remoteDebugHost: "",
        wslHostIp: "192.0.2.11",
        resolvConf: "nameserver 127.0.0.53\n",
      }),
    ).toBe("192.0.2.11");
  });

  test("does not normalize an explicit loopback remote-debug host", () => {
    expect(
      resolveWslChromeLaunchRoute({
        remoteDebugHost: "127.0.0.53",
        wslHostIp: "192.0.2.11",
        resolvConf: "nameserver 127.0.0.54\n",
      }),
    ).toEqual({
      connectHost: "127.0.0.53",
      debugBindAddress: "0.0.0.0",
      usePatchedLauncher: true,
    });
  });

  test("routes a resolver-derived loopback host through the standard local launcher", () => {
    expect(
      resolveWslChromeLaunchRoute({
        remoteDebugHost: "",
        wslHostIp: "",
        resolvConf: "nameserver 127.0.0.53\n",
      }),
    ).toEqual({
      connectHost: "127.0.0.1",
      debugBindAddress: "127.0.0.1",
      usePatchedLauncher: false,
    });
  });

  test("keeps a resolver-derived non-loopback host on the custom launcher", () => {
    expect(
      resolveWslChromeLaunchRoute({
        remoteDebugHost: "",
        wslHostIp: "",
        resolvConf: "nameserver 172.28.224.1\n",
      }),
    ).toEqual({
      connectHost: "172.28.224.1",
      debugBindAddress: "0.0.0.0",
      usePatchedLauncher: true,
    });
  });
});
