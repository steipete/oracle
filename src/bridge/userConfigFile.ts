import fs from "node:fs/promises";
import JSON5 from "json5";
import { writeUserConfig, type UserConfig } from "../config.js";

export async function readUserConfigFile(
  configPath: string,
): Promise<{ config: UserConfig; loaded: boolean }> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON5.parse(raw) as UserConfig;
    return { config: parsed ?? {}, loaded: true };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return { config: {}, loaded: false };
    }
    throw new Error(
      `Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function writeUserConfigFile(configPath: string, config: UserConfig): Promise<void> {
  await writeUserConfig(config, configPath);
}
