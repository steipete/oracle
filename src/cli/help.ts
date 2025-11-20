import type { Command } from 'commander';
import kleur from 'kleur';

type Stylizer = (text: string) => string;

interface HelpColors {
  banner: Stylizer;
  subtitle: Stylizer;
  section: Stylizer;
  bullet: Stylizer;
  command: Stylizer;
  option: Stylizer;
  argument: Stylizer;
  description: Stylizer;
  muted: Stylizer;
  accent: Stylizer;
}

const createColorWrapper = (isTty: boolean) => (styler: Stylizer): Stylizer => (text) =>
  isTty ? styler(text) : text;

export function applyHelpStyling(program: Command, version: string, isTty: boolean): void {
  const wrap = createColorWrapper(isTty);
  const colors: HelpColors = {
    banner: wrap((text) => kleur.bold().blue(text)),
    subtitle: wrap((text) => kleur.dim(text)),
    section: wrap((text) => kleur.bold().white(text)),
    bullet: wrap((text) => kleur.blue(text)),
    command: wrap((text) => kleur.bold().blue(text)),
    option: wrap((text) => kleur.cyan(text)),
    argument: wrap((text) => kleur.magenta(text)),
    description: wrap((text) => kleur.white(text)),
    muted: wrap((text) => kleur.gray(text)),
    accent: wrap((text) => kleur.cyan(text)),
  };

  program.configureHelp({
    styleTitle(title) {
      return colors.section(title);
    },
    styleDescriptionText(text) {
      return colors.description(text);
    },
    styleCommandText(text) {
      return colors.command(text);
    },
    styleSubcommandText(text) {
      return colors.command(text);
    },
    styleOptionText(text) {
      return colors.option(text);
    },
    styleArgumentText(text) {
      return colors.argument(text);
    },
  });

  program.addHelpText('beforeAll', () => renderHelpBanner(version, colors));
  program.addHelpText('after', () => renderHelpFooter(program, colors));
}

function renderHelpBanner(version: string, colors: HelpColors): string {
  const subtitle = 'GPT-5.1 Pro/GPT-5.1 for tough questions with code/file context.';
  return `${colors.banner(`Oracle CLI v${version}`)} ${colors.subtitle(`— ${subtitle}`)}\n`;
}

function renderHelpFooter(program: Command, colors: HelpColors): string {
  const tips = [
    `${colors.bullet('•')} Oracle cannot see your project unless you pass ${colors.accent('--file …')} — attach the files/dirs you want it to read.`,
    `${colors.bullet('•')} Attach lots of source (whole directories beat single files) and keep total input under ~196k tokens.`,
    `${colors.bullet('•')} Oracle starts empty—open with a short project briefing (stack, services, build steps), spell out the question and prior attempts, and why it matters; the more explanation and context you provide, the better the response will be.`,
    `${colors.bullet('•')} Spell out the project + platform + version requirements (repo name, target OS/toolchain versions, API dependencies) so Oracle doesn’t guess defaults.`,
    `${colors.bullet('•')} When comparing multiple repos/files, spell out each repo + path + role (e.g., “Project A SettingsView → apps/project-a/Sources/SettingsView.swift; Project B SettingsView → ../project-b/mac/...”) so the model knows exactly which file is which.`,
    `${colors.bullet('•')} Best results: 6–30 sentences plus key source files; very short prompts often yield generic answers.`,
    `${colors.bullet('•')} Oracle is one-shot: it does not remember prior runs, so start fresh each time with full context.`,
    `${colors.bullet('•')} Run ${colors.accent('--files-report')} to inspect token spend before hitting the API.`,
    `${colors.bullet('•')} Non-preview runs spawn detached sessions (especially gpt-5.1-pro API). If the CLI times out, do not re-run — reattach with ${colors.accent('oracle session <slug>')} to resume/inspect the existing run.`,
    `${colors.bullet('•')} Set a memorable 3–5 word slug via ${colors.accent('--slug "<words>"')} to keep session IDs tidy.`,
    `${colors.bullet('•')} Finished sessions auto-hide preamble logs when reattached; raw timestamps remain in the saved log file.`,
    `${colors.bullet('•')} Need hidden flags? Run ${colors.accent(`${program.name()} --help --verbose`)} to list search/token/browser overrides.`,
    `${colors.bullet('•')} If any Oracle session is already running, do not start new API runs. Attach to the existing browser session instead; only trigger API calls when you explicitly mean to.`,
    `${colors.bullet('•')} Duplicate prompt guard: if the same prompt is already running, new runs are blocked unless you pass ${colors.accent('--force')}—prefer reattaching instead of spawning duplicates.`,
  ].join('\n');

  const formatExample = (command: string, description: string): string =>
    `${colors.command(`  ${command}`)}\n${colors.muted(`    ${description}`)}`;

  const examples = [
    formatExample(
      `${program.name()} --prompt "Summarize risks" --file docs/risk.md --files-report --preview`,
      'Inspect tokens + files without calling the API.',
    ),
    formatExample(
      `${program.name()} --prompt "Explain bug" --file src/,docs/crash.log --files-report`,
      'Attach src/ plus docs/crash.log, launch a background session, and capture the Session ID.',
    ),
    formatExample(
      `${program.name()} status --hours 72 --limit 50`,
      'Show sessions from the last 72h (capped at 50 entries).',
    ),
    formatExample(
      `${program.name()} session <sessionId>`,
      'Attach to a running/completed session and stream the saved transcript.',
    ),
    formatExample(
      `${program.name()} --prompt "Ship review" --slug "release-readiness-audit"`,
      'Encourage the model to hand you a 3–5 word slug and pass it along with --slug.',
    ),
    formatExample(
      `${program.name()} --prompt "Tabs frozen: compare Project A SettingsView (apps/project-a/Sources/SettingsView.swift) vs Project B SettingsView (../project-b/mac/App/Presentation/Views/SettingsView.swift)" --file apps/project-a/Sources/SettingsView.swift --file ../project-b/mac/App/Presentation/Views/SettingsView.swift`,
      'Spell out what each attached file is (repo + path + role) before asking for comparisons so the model knows exactly what it is reading.',
    ),
  ].join('\n\n');

  return `
${colors.section('Tips')}
${tips}

${colors.section('Examples')}
${examples}
`;
}
