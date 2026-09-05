export interface GeminiWebOptions {
  allowModelFallback?: boolean;
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
