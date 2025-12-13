export interface GeminiWebOptions {
  youtube?: string;
  generateImage?: string;
  editImage?: string;
  outputPath?: string;
  showThoughts?: boolean;
  aspectRatio?: string;
}

export interface GeminiWebResponse {
  text: string | null;
  thoughts: string | null;
  has_images: boolean;
  image_count: number;
  error?: string;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
