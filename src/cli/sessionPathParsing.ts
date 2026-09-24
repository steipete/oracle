import { Command, CommanderError, Option } from "commander";

export function scopeSessionPathOption(program: Command, args: string[]): string[] {
  const rootPath = program.options.find((option) => option.long === "--path");
  if (!rootPath) return args;

  // Let Commander distinguish a subcommand from an option value or literal prompt.
  const probe = new Command()
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });
  for (const option of program.options) probe.addOption(new Option(option.flags));
  for (const command of program.commands) probe.command(command.name());
  let parsed: ReturnType<Command["parseOptions"]>;
  try {
    parsed = probe.parseOptions([...args, "--"]);
  } catch (error) {
    if (error instanceof CommanderError) return args; // The real parser reports invalid input.
    throw error;
  }
  const commandIndex = args.length - parsed.unknown.length;
  if (parsed.operands[0] !== "session" || args[commandIndex] !== "session") return args;

  // Preserve root aliases before the command, then let session own its boolean --path.
  program.parseOptions(args.slice(0, commandIndex));
  program.options = program.options.filter((option) => option !== rootPath);
  return args.slice(commandIndex);
}
