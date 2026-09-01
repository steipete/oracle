export interface PerplexityWebOptions {
  /** Append the answer's cited sources to the returned markdown. Defaults to true. */
  includeSources?: boolean;
  /** Path from --generate-image; the first generated image is written here. */
  generateImage?: string;
  /** Path from --output, which takes precedence over generateImage when both are set. */
  outputPath?: string;
}
