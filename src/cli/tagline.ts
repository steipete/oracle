import chalk from 'chalk';

const TAGLINES = [
  'Whispering your tokens to the silicon sage.',
  'Turning scattered files into one sharp question.',
  'One slug to gather them all.',
  'Token thrift, oracle lift.',
  'Globs to gospel, minus the incense.',
  'Your repo, neatly bottled, gently shaken.',
  'Clarity, with a hint of smoke.',
  'Questions in, clarity out.',
  'Globs become guidance.',
  'Token-aware, omen-ready.',
  'Globs go in; citations and costs come out.',
  'Keeps 196k tokens feeling roomy, not risky.',
  'Remembers your paths, forgets your past runs.',
  'A TUI when you want it, a one-liner when you do not.',
  'Less ceremony, more certainty.',
  'Guidance without the guesswork.',
  'One prompt fanned out, no echoes wasted.',
  'Detached runs, tethered results.',
  'Calm CLI, loud answers.',
  'Single scroll, many seers.',
  'Background magic with foreground receipts.',
  'Paths aligned, models attuned.',
  'Light spell, heavy insight.',
  'Signal first, sorcery second.',
  'One command, several seers; results stay grounded.',
  'Context braided, answers sharpened.',
  'Short incantation, long provenance.',
  'Attach, cast, reattach later.',
  'Spell once, cite always.',
  'Edge cases foretold, receipts attached.',
  'Silent run, loud receipts.',
  'Detours gone; clarity walks in.',
  'Tokens tallied, omens tallied.',
  'Calm prompt, converged truths.',
  'Single spell, multiple verdicts.',
  'Prompt once, harvest many omens.',
  'Light on ceremony, heavy on receipts.',
  'From globs to guidance in one breath.',
  'Quiet prompt, thunderous answers.',
  'Balanced mystique, measurable results.',
  'Debugger by day, oracle by night.',
  "Your code's confessional booth.",
  'Edge cases fear this inbox.',
  'Slop in, sharp answers out.',
  "Your AI coworker's quality control.",
  "Because vibes aren't a deliverable.",
  'When the other agents shrug, the oracle ships.',
  'Hallucinations checked at the door.',
  'Context police for overeager LLMs.',
  'Turns prompt spaghetti into ship-ready sauce.',
  'Lint for large language models.',
  "Slaps wrists before they hit 'ship'.",
  "Because 'let the model figure it out' is not QA.",
  "Fine, I'll write the test for the AI too.",
  'We bring receipts; they bring excuses.',
  'Less swagger, more citations.',
  'LLM babysitter with a shipping agenda.',
  'Ships facts, not vibes.',
  'Context sanitizer for reckless prompts.',
  'AI babysitter with merge rights.',
  'Stops the hallucination before it hits prod.',
  'Slop filter set to aggressive.',
  'We debug the debugger.',
  'Model said maybe; oracle says ship/no.',
  'Less lorem, more logic.',
  "Your prompt's adult supervision.",
  'Cleanup crew for AI messes.',
  'AI wrote it? Oracle babysits it.',
  'Turning maybe into mergeable.',
  'The AI said vibes; we said tests.',
  'Cleanup crew for model-made messes—now with citations.',
  'Less hallucination, more escalation.',
  "Your AI's ghostwriter, but with citations.",
  'Where prompt soup becomes production code.',
  'From shruggy agents to shippable PRs.',
  'Token mop for agent spillover.',
  'We QA the AI so you can ship the code.',
  'Less improv, more implementation.',
  'Ships facts faster than agents make excuses.',
  'From prompt chaos to PR-ready prose.',
  "Your AI's hot take, fact-checked.",
  'Cleanup crew for LLM loose ends.',
  'We babysit the bot; you ship the build.',
  'Prompt drama in; release notes out.',
  'AI confidence filtered through reality.',
  "From 'it told me so' to 'tests say so'.",
  "We refactor the model's hubris before it hits prod.",
  'Prompt chaos triaged, answers discharged.',
  'Oracle babysits; you merge.',
  'Vibes quarantined; facts admitted.',
  'The cleanup crew for speculative stack traces.',
  'Ship-ready answers, minus the AI improv.',
  "We pre-empt the hallucination so you don't triage it at 2am.",
  'AI confidence monitored, citations required.',
  'Ship logs, not lore.',
  'Hallucinations flagged, reality shipped.',
  'We lint the lore so you can ship the code.',
  'Hallucination hotline: we answer, not the pager.',
  'Less mystique, more mergeability.',
  'Slop filter set past 11.',
  'Bottled prompt chaos, filtered answers.',
  "Your AI's swagger, audited.",
  'New year, same oracle: resolutions shipped, not wished.',
  'Lunar New Year sweep: clear caches, invite good deploys.',
  'Eid Mubarak: feast on clarity, fast from hallucinations.',
  'Diwali: lights on, incident lights off.',
  'Holi colors on dashboards, not in logs.',
  "Workers' Day: let oracle haul the heavy context.",
  'Earth Day: trim carbon, trim token waste.',
  'Halloween: ship treats, not trick exceptions.',
  'Independence Day: sparkles in the sky, not in the error console.',
  'Christmas: all is calm, all is shipped.',
  'Nowruz reset: sweep caches, welcome clean deploys.',
  'Hanukkah lights, zero prod fires.',
  'Ramadan focus: fast from scope creep, feast on clarity.',
  'Pride Month: more color on the streets, less red in CI.',
  'Thanksgiving: grateful for green builds, no turkey outages.',
  'Solstice deploy: longest day, shortest incident list.',
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
