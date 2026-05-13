import { describe, expect, it } from "vitest";
import {
  formatBridgeConnectionString,
  parseBridgeConnectionString,
  parseHostPort,
} from "../../src/bridge/connection.js";

describe("bridge connection parsing", () => {
  it("parses host:port?token=...", () => {
    const parsed = parseBridgeConnectionString("127.0.0.1:9473?token=abc");
    expect(parsed).toEqual({ remoteHost: "127.0.0.1:9473", remoteToken: "abc" });
  });

  it("parses oracle+tcp://host:port?token=...", () => {
    const parsed = parseBridgeConnectionString("oracle+tcp://example.com:1234?token=secret");
    expect(parsed).toEqual({ remoteHost: "example.com:1234", remoteToken: "secret" });
  });

  it("parses IPv6 hosts with brackets", () => {
    const parsed = parseBridgeConnectionString("oracle+tcp://[2001:db8::1]:9473?token=abc");
    expect(parsed).toEqual({ remoteHost: "[2001:db8::1]:9473", remoteToken: "abc" });
  });

  it("formats connection strings (with and without token)", () => {
    const withToken = formatBridgeConnectionString(
      { remoteHost: "127.0.0.1:9473", remoteToken: "abc" },
      { includeToken: true },
    );
    expect(withToken).toBe("oracle+tcp://127.0.0.1:9473?token=abc");

    const withoutToken = formatBridgeConnectionString(
      { remoteHost: "127.0.0.1:9473", remoteToken: "abc" },
      { includeToken: false },
    );
    expect(withoutToken).toBe("oracle+tcp://127.0.0.1:9473");
  });

  it("rejects unbracketed IPv6 in host:port parsing", () => {
    expect(() => parseHostPort("2001:db8::1:9473")).toThrow(/Wrap IPv6 addresses in brackets/i);
  });

  it("rejects ports with non-numeric suffixes", () => {
    expect(() => parseHostPort("127.0.0.1:9473abc")).toThrow(/Invalid port/i);
    expect(() => parseBridgeConnectionString("oracle+tcp://example.com:9473abc?token=abc")).toThrow(
      /Invalid connection string|Invalid connection string host/i,
    );
  });
});
