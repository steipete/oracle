import { Marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

const renderer = new TerminalRenderer({
  reflowText: false,
  width: process.stdout.columns ? Math.max(20, process.stdout.columns - 2) : undefined,
  tab: 2,
});

// Make terminal renderer's options non-enumerable to satisfy Marked's renderer shape checks.
if (renderer && Object.prototype.hasOwnProperty.call(renderer as object, 'options')) {
  const optionsValue = (renderer as unknown as { options?: unknown }).options;
  Object.defineProperty(renderer, 'options', {
    value: optionsValue,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

const markedWithTerminal = new Marked({ renderer: renderer as unknown as any });

/**
 * Render markdown to ANSI-colored text suitable for a TTY.
 */
export function renderMarkdownAnsi(markdown: string): string {
  return markedWithTerminal.parse(markdown) as string;
}
