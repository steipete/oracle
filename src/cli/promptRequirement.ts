interface PromptCheckOptions {
  prompt?: string;
  session?: string;
  execSession?: string;
  status?: boolean;
  debugHelp?: boolean;
  renderMarkdown?: boolean;
  preview?: boolean | string;
  dryRun?: boolean;
}

/**
 * Determine whether the CLI should enforce a prompt requirement based on raw args and options.
 */
export function shouldRequirePrompt(rawArgs: string[], options: PromptCheckOptions): boolean {
  if (rawArgs.length === 0) {
    return !options.prompt;
  }
  const firstArg = rawArgs[0];
  const bypassPrompt = Boolean(
    options.session ||
      options.execSession ||
      options.status ||
      options.debugHelp ||
      firstArg === 'status' ||
      firstArg === 'session',
  );

  const requiresPrompt = options.renderMarkdown || Boolean(options.preview) || Boolean(options.dryRun) || !bypassPrompt;
  return requiresPrompt && !options.prompt;
}
