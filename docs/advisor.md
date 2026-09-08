# Transport-explicit advisory consultations

The optional `oracle-advisor` skill separates the advisory request from the
transport used to execute it. It reuses Oracle's current CLI/MCP integration;
the existing `oracle` skill remains available unchanged.

| Transport      | Execution today                                            | Evidence and recovery                                                                              |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| API            | An authorized configured provider, selected explicitly     | Stored session, provider route, response and usage metadata; inspect before retrying               |
| Browser        | Authorized signed-in ChatGPT or supported browser provider | Stored session and available conversation/selection evidence; reattach after an incomplete capture |
| Render         | Local context bundle for manual handoff                    | Bundle only; no automatic answer, completion claim, or session reference                           |
| Native desktop | Not implemented                                            | A shared desktop UI does not establish a supported delegation capability                           |

An advisory request specifies its prompt/files, allowed transport, required
model/effort, output contract, and fresh-versus-follow-up intent. Its result
includes the answer or incomplete state, available durable references,
requested and observed/effective settings, selection evidence, and uncertainty.
These are reporting requirements for the skill, not a new executable schema.

Unavailable transport and unsatisfied model/effort constraints remain visible.
An already authorized fallback can be used; otherwise the caller chooses it.
The advisory model does not acquire permission to edit the repository.

Future native execution would require a documented callable interface with
model/effort control, submission, completion, result reading, and durable
references. No private desktop protocol or native adapter is part of this
skill. HTTP protocols, new MCP tools, and core backend abstractions are also
outside this change.

Copy `skills/oracle-advisor` from the source repository into the host's skill
directory, just as for the existing skill. See [Coding Agents](agents.md) for
host setup and [MCP](mcp.md) for the current tools.
