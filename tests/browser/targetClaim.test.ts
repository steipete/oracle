import { test, expect } from "vitest";
import {
  buildTargetClaimExpression,
  buildTargetRetirementExpression,
  buildTargetRetirementRollbackExpression,
  normalizeChromeHost,
} from "../../src/browser/targetClaim.js";

function renderer() {
  const storage = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  const run = (expression: string) => {
    const window = {};
    Object.assign(window, { top: window });
    // Each call has a fresh document global, but the same per-tab storage.
    return new Function(
      "globalThis",
      "window",
      "sessionStorage",
      "location",
      "document",
      `return ${expression}`,
    )({}, window, sessionStorage, { pathname: "/c/owned" }, { querySelectorAll: () => [] });
  };
  return { run, storage, sessionStorage };
}
test("retirement survives document replacement and excludes a new controller", () => {
  const { run } = renderer();
  expect(run(buildTargetClaimExpression("original"))).toBe(true);
  expect(run(buildTargetRetirementExpression("original", "owned", "reservation-a"))).toBe(true);
  expect(run(buildTargetClaimExpression("new-controller"))).toBe(false);
});
test("borrower ownership survives document replacement and blocks original retirement", () => {
  const { run } = renderer();
  expect(run(buildTargetClaimExpression("original"))).toBe(true);
  expect(run(buildTargetClaimExpression("new-controller"))).toBe(true);
  expect(run(buildTargetRetirementExpression("original", "owned", "reservation-a"))).toBe(false);
});
test("missing, malformed, and inaccessible storage never authorizes retirement", () => {
  const { run, storage, sessionStorage } = renderer();
  expect(run(buildTargetRetirementExpression("original", "owned", "reservation-a"))).toBe(false);
  storage.set("oracle:target-claim", "{invalid");
  expect(run(buildTargetRetirementExpression("original", "owned", "reservation-a"))).toBe(false);
  sessionStorage.getItem = () => {
    throw new Error("storage unavailable");
  };
  expect(run(buildTargetClaimExpression("original"))).toBe(false);
  expect(run(buildTargetRetirementExpression("original", "owned", "reservation-a"))).toBe(false);
});
test("loopback aliases share a controller identity", () => {
  expect(["localhost", "127.0.0.1", "127.0.0.2", "::1", "[::1]"].map(normalizeChromeHost)).toEqual(
    Array(5).fill("loopback"),
  );
});

test("failed concurrent retirement cannot release another caller's reservation", () => {
  const { run } = renderer();
  expect(run(buildTargetClaimExpression("original"))).toBe(true);
  expect(run(buildTargetRetirementExpression("original", "owned", "reservation-a"))).toBe(true);
  expect(run(buildTargetRetirementExpression("original", "owned", "reservation-b"))).toBe(false);
  run(buildTargetRetirementRollbackExpression("original", "reservation-b"));
  expect(run(buildTargetClaimExpression("borrower"))).toBe(false);
  run(buildTargetRetirementRollbackExpression("original", "reservation-a"));
  expect(run(buildTargetClaimExpression("borrower"))).toBe(true);
});
