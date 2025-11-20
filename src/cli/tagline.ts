import chalk from 'chalk';

const TAGLINES = [
  'Whispering your tokens to the silicon sage.',
  'Bundling your code lore for the models that care.',
  'Couriering prompts + files straight to the oracle’s desk.',
  'Packing your repo into a single scroll for wise counsel.',
  'Turning scattered files into one sharp question.',
  'Gating the model with just the context that matters.',
  'Carrying your source notes into the think tank.',
  'Lining up code, docs, and intent for clean answers.',
  'One-shot context drop: speak once, be understood.',
  'Wrangling globs and guidance into a model-ready brief.',
];

export interface TaglineOptions {
  env?: NodeJS.ProcessEnv;
  random?: () => number;
  richTty?: boolean;
}

export function pickTagline(options: TaglineOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env?.ORACLE_TAGLINE_INDEX;
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return TAGLINES[parsed % TAGLINES.length];
    }
  }
  const rand = options.random ?? Math.random;
  const index = Math.floor(rand() * TAGLINES.length) % TAGLINES.length;
  return TAGLINES[index];
}

export function formatIntroLine(version: string, options: TaglineOptions = {}): string {
  const tagline = pickTagline(options);
  const rich = options.richTty ?? true;
  if (rich && chalk.level > 0) {
    return `${chalk.bold('🧿 oracle')} ${version} ${chalk.dim(`— ${tagline}`)}`;
  }
  return `🧿 oracle ${version} — ${tagline}`;
}

export { TAGLINES };
