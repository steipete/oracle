# TUI PageUp/PageDown crash notes (2025-11-19)

What was happening
- Pressing PageUp/PageDown in the session selector could crash because Inquirer tried to land on a separator/header entry that had no value.
- Physical PageUp/PageDown also did not trigger paging; they sometimes caused the prompt to explode instead of navigating.

What we learned
- Inquirer’s list prompt will wrap or jump pages on PageUp/PageDown and can leave the pointer on a non-selectable item.
- Leading separators or header rows without a value make crashes more likely when the pointer lands there.
- Sending literal PageUp/PageDown ANSI sequences via iTerm MCP isn’t reliable; focus can jump to another pane/run.

Repro steps
1) `npx tsx bin/oracle-cli.ts` (rich TTY required).
2) In the initial list, press PageDown before selecting anything.
3) Crash occurs if the pointer lands on a separator/header (was observed prior to fixes).

Mitigations implemented
- Start the list with a selectable row (“ask oracle”) to avoid initial pointer on a separator.
- Render table headers as disabled choices (not separators) so paging over them is safer.
- Removed PageUp/PageDown shortcuts entirely; navigation now relies on the on-screen Older/Newer actions.

Open follow-ups
- Consider a custom prompt wrapper (outside Inquirer’s list) for key handling to avoid relying on private UI internals.
- Add a unit test that simulates `pagedown` on the prompt UI to catch regressions.
