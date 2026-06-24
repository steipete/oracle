import type { UserConfig } from "../config.js";
import { DEFAULT_MAX_FILE_SIZE_BYTES, normalizeMaxFileSizeBytes } from "../oracle/files.js";

export function resolveConfiguredMaxFileSizeBytes(
  userConfig?: UserConfig,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const envValue = env.ORACLE_MAX_FILE_SIZE_BYTES?.trim();
  if (envValue) {
    return normalizeMaxFileSizeBytes(envValue, "ORACLE_MAX_FILE_SIZE_BYTES");
  }
  if (userConfig?.maxFileSizeBytes !== undefined) {
    return normalizeMaxFileSizeBytes(userConfig.maxFileSizeBytes, "config.maxFileSizeBytes");
  }
  return DEFAULT_MAX_FILE_SIZE_BYTES;
}
