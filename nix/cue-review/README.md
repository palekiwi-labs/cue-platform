# Review run provenance

`review/runs/<RUN_ID>/run.json` is the runner-owned summary. RUN_ID is
the start time in Unix seconds; PR runs live in `review-pr-<N>`. Unlike agent
artifacts, it is atomically replaced after each phase. Existing runs are
not migrated. `schema_version: 1` has:

- `target`, `base`, `head`, `context`, `run_id`, `diff_command`:
  reviewed lineage. The diff is not stored; `diff_command` reproduces
  it, and `refs/review/runs/<RUN_ID>/{base,head}` keep both shas
  reachable.
  `target` is `{kind, subject, refs, pr?}` (kind `pr`, `branch`,
  `commit`, `range`), or `{kind: run}` for a bare `cue-review run`; it is
  the same for detached and foreground runs. The cue-agent job label is
  `<subject> · <context> · <manifest>`.
- `manifest`: resolved path and filename stem (name).
- `state`: `running`, `completed`, `incomplete`, `failed`, or `aborted`.
- `phases`: specification-order records with `phase`, `state` (`pending`,
  `finished`, `skipped`), and `entries`. Finished phases also record
  supervisor exit code, batch ID and harness/version.
- Each entry: name, agent, requested model alias, input artifact
  addresses, expected output artifact address, artifact presence, receipt availability,
  an allowlisted `receipt`, and `observed` activity.

The receipt retains execution metrics, outcome and errors, not responses
or stderr. Unknown fields remain null. Its model is configuration-first
in cue-agent, **not guaranteed to be observed at runtime**.
`observed.models` lists distinct provider/model pairs from assistant
`message_end` events. Neither field is agent-authored artifact metadata.

`observed.requests` records unique read/grep/find/ls requests with explicit
paths from `tool_execution_start`. It does not prove reads succeeded and
search roots are not files examined. It omits shell commands, raw argument
payloads and search patterns. Only the first 10,000 event lines and 500
unique requests are summarized; limits, malformed lines and receipt stream
truncation are reported. Unavailable streams are explicit. Paths may refer
to ephemeral worktrees and are observations, not durable file handles.

Execution success and artifact presence are independent. At least one
artifact still allows a phase to continue; missing receipts make the final
run incomplete even if artifacts exist. No receipt does not imply an abort.
A summary persistence failure fails the command. SIGINT/SIGKILL can leave
only the last phase snapshot; `running` is not a liveness guarantee.

Agent findings retain stable IDs and `source_ids`
(`<artifact address>#<finding>`). Resolve source artifact addresses
against run entries for model attribution.
Agents retain judgments, including questions, disagreements and unreadable
input reports; they do not duplicate orchestration provenance.
