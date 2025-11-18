import type { OptionValues } from 'commander';

export interface HiddenAliasOptions extends OptionValues {
  prompt?: string;
  message?: string;
  file?: string[];
  include?: string[];
}

type OptionSetter = (key: string, value: unknown) => void;

/**
 * Normalize hidden alias flags so they behave like their primary counterparts.
 *
 * - `--message` maps to `--prompt` when no prompt is provided.
 * - `--include` extends the `--file` list.
 */
export function applyHiddenAliases(options: HiddenAliasOptions, setOptionValue?: OptionSetter): void {
  if (options.include && options.include.length > 0) {
    const mergedFiles = [...(options.file ?? []), ...options.include];
    options.file = mergedFiles;
    setOptionValue?.('file', mergedFiles);
  }
  if (!options.prompt && options.message) {
    options.prompt = options.message;
    setOptionValue?.('prompt', options.message);
  }
}
