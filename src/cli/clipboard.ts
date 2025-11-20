import clipboard from 'clipboardy';

export interface CopyResult {
  success: boolean;
  command?: string;
  error?: unknown;
}

export async function copyToClipboard(text: string): Promise<CopyResult> {
  try {
    await clipboard.write(text);
    return { success: true, command: 'clipboardy' };
  } catch (error) {
    return { success: false, error };
  }
}
