export interface PerplexityWebOptions {
  /**
   * Resolved Oracle model id. Preferred over `config.desiredModel`, which is a
   * browser picker label a user can override (`--browser-model-label`) and would
   * otherwise silently downgrade a Deep research run to Search.
   */
  modelId?: string;
  /** Append the answer's cited sources to the returned markdown. Defaults to true. */
  includeSources?: boolean;
  /** Path from --generate-image; the first generated image is written here. */
  generateImage?: string;
  /** Path from --output, which takes precedence over generateImage when both are set. */
  outputPath?: string;
}
