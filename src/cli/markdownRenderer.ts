import chalk from 'chalk';
import { render as renderMarkdown } from 'markdansi';
import {
  bundledLanguages,
  bundledThemes,
  createHighlighter,
  type BundledTheme,
} from 'shiki';

type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

const DEFAULT_THEME: BundledTheme = 'github-dark';
const HIGHLIGHT_LANGS = ['ts', 'tsx', 'js', 'jsx', 'json', 'swift'] as const;
type HighlightLang = (typeof HIGHLIGHT_LANGS)[number];

const SUPPORTED_LANG_ALIASES: Record<string, HighlightLang> = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  json: 'json',
  swift: 'swift',
};

const shikiPromise = createHighlighter({
  themes: [bundledThemes[DEFAULT_THEME]],
  langs: HIGHLIGHT_LANGS.map((lang) => bundledLanguages[lang]),
});

let shiki: ShikiHighlighter | null = null;
void shikiPromise
  .then((instance) => {
    shiki = instance;
  })
  .catch(() => {
    shiki = null;
  });

export async function ensureShikiReady(): Promise<void> {
  if (shiki) return;
  try {
    shiki = await shikiPromise;
  } catch {
    shiki = null;
  }
}

function normalizeLanguage(lang?: string): HighlightLang | null {
  if (!lang) return null;
  const key = lang.toLowerCase();
  return SUPPORTED_LANG_ALIASES[key] ?? null;
}

function styleToken(text: string, fontStyle = 0): string {
  let styled = text;
  if (fontStyle & 1) styled = chalk.italic(styled);
  if (fontStyle & 2) styled = chalk.bold(styled);
  if (fontStyle & 4) styled = chalk.underline(styled);
  if (fontStyle & 8) styled = chalk.strikethrough(styled);
  return styled;
}

function shikiHighlighter(code: string, lang?: string): string {
  if (!process.stdout.isTTY || !shiki) return code;

  const normalizedLang = normalizeLanguage(lang);
  if (!normalizedLang) return code;

  try {
    if (!shiki.getLoadedLanguages().includes(normalizedLang)) {
      return code;
    }
    const { tokens } = shiki.codeToTokens(code, { lang: normalizedLang, theme: DEFAULT_THEME });
    return tokens
      .map((line) =>
        line
          .map((token) => {
            const colored = token.color ? chalk.hex(token.color)(token.content) : token.content;
            return styleToken(colored, token.fontStyle);
          })
          .join(''),
      )
      .join('\n');
  } catch {
    return code;
  }
}

export function renderMarkdownAnsi(markdown: string): string {
  try {
    const color = Boolean(process.stdout.isTTY);
    const width = process.stdout.columns;
    const hyperlinks = color; // enable OSC 8 only when we have color/TTY
    return renderMarkdown(markdown, {
      color,
      width,
      wrap: true,
      hyperlinks,
      highlighter: color ? shikiHighlighter : undefined,
    });
  } catch {
    // Last-resort fallback: return the raw markdown so we never crash.
    return markdown;
  }
}
