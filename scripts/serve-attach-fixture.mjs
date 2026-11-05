import assert from "node:assert/strict";
import path from "node:path";

export function fixtureEnvironment(home, inherited = process.env) {
  return {
    ...inherited,
    ORACLE_HOME_DIR: home,
    // Windows discovery uses LOCALAPPDATA instead of os.homedir().
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  };
}

export async function expectRefusal(child, label, timeoutMs = 20_000) {
  let output = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      // Wait for stdio too, so failure diagnostics include the final output.
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.ok(!timedOut, `${label}: timed out after ${timeoutMs}ms\n${output}`);
    assert.equal(
      code,
      1,
      `${label}: expected synthetic endpoint refusal (signal: ${signal})\n${output}`,
    );
    return output;
  } finally {
    clearTimeout(timeout);
  }
}
