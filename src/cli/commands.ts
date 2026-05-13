export interface CommandFlagSelection {
  name: string;
  selected?: boolean;
}

export function assertNoConflictingCommandFlags(
  flags: CommandFlagSelection[],
  context = "command",
): void {
  const selected = flags.filter((flag) => flag.selected === true);
  if (selected.length <= 1) {
    return;
  }
  const names = selected.map((flag) => flag.name);
  const joined =
    names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  throw new Error(`Cannot combine ${joined} for ${context}. Choose one.`);
}
