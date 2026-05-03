export interface CopyResult {
  success: boolean;
  command?: string;
  error?: unknown;
}

async function loadClipboard() {
  if (process.platform === "darwin" && process.arch === "x64") {
    const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
    if (!paths.includes("/usr/sbin")) {
      process.env.PATH = ["/usr/sbin", ...paths].join(":");
    }
  }

  return (await import("clipboardy")).default;
}

export async function copyToClipboard(text: string): Promise<CopyResult> {
  try {
    const clipboard = await loadClipboard();
    await clipboard.write(text);
    return { success: true, command: "clipboardy" };
  } catch (error) {
    return { success: false, error };
  }
}
