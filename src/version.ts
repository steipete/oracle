import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

export function getCliVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  cachedVersion = readVersionFromPackage();
  return cachedVersion;
}

function readVersionFromPackage(): string {
  const modulePath = fileURLToPath(import.meta.url);
  let currentDir = path.dirname(modulePath);
  const filesystemRoot = path.parse(currentDir).root;

  while (true) {
    const candidate = path.join(currentDir, "package.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      const version =
        typeof parsed.version === "string" && parsed.version.trim().length > 0
          ? parsed.version.trim()
          : "0.0.0";
      return version;
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
      if (code && code !== "ENOENT") {
        break;
      }
    }
    if (currentDir === filesystemRoot) {
      break;
    }
    currentDir = path.dirname(currentDir);
  }
  return "0.0.0";
}
