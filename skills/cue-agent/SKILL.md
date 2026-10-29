---
name: cue-agent
description: Define and run named coding agents with the cue-agent binary. Use when the user wants to create or edit an agent (globally or per project), run agents on prompts or in parallel, or monitor, inspect or stop agent runs.
---

# cue-agent

`cue-agent` runs named coding agents as child harness processes (pi or
claude-code). One invocation is one batch of up to four tasks that run
concurrently; it prints one receipt when the last finishes.

Full reference: `docs/cue-agent.md` in the cue repo
(`/home/pl/code/palekiwi-labs/cue`, branch `cue-agent-prototype`).

## Where agents are defined

Two JSON manifest layers, merged field by field (project wins):

1. Global: `$XDG_CONFIG_HOME/cue/cue-agent.json`
   (default `~/.config/cue/cue-agent.json`).
2. Project: the nearest `cue-agent.json` at or above the working directory,
   stopping at the repository root. Outside a repo only the cwd is checked.

`agents` is an object keyed by name. A project file can add an agent or
override one field of a global agent without restating it. Arrays (`tools`,
`models`) replace whole; `null` clears an optional value.

Check the merged result after any edit:

    cue-agent agents list
    cue-agent agents list --json   # shows field_sources per layer

## Manifest shape

Root keys: `timeout`, `worktree_root`, `models`, `agents` (unknown keys are
rejected).

    {
      "timeout": 900,
      "models": {
        "haiku": { "id": "anthropic/claude-haiku-4", "provider": "anthropic" },
        "opus":  { "id": "anthropic/claude-opus-4", "thinking": "high" }
      },
      "agents": {
        "explore": {
          "description": "Surveys unfamiliar code and reports what is where",
          "models": ["haiku", "opus"],
          "system_prompt": { "file": "prompts/explore.md" },
          "tools": ["read", "bash"]
        }
      }
    }

Agent fields (all optional):

- `description`: what the agent is for; this is what a calling model reads.
- `harness`: `pi` (default) or `claude-code`. Manifest-only.
- `models`: ordered allowlist of registry aliases; first is the default.
  Omit to use the harness default model.
- `system_prompt`: supplementary instructions appended to the harness base
  prompt. Use `{ "file": "path" }` for anything longer than a line; the
  path is relative to the manifest that declares it.
- `tools`: omit for harness defaults, `[]` for no tools, or a list.

Agents have no `model`/`thinking` field; the model profile supplies both.
Prompts, cwd, env and context never go in the manifest.

## How a spawned agent knows what to do

Four layers, from most stable to most specific:

1. `system_prompt` in the manifest: the agent's standing role.
2. The repo it runs in: the task `cwd` decides which `AGENTS.md` (pi) or
   `CLAUDE.md` (claude-code) and skills the harness loads. Keep codebase
   rules there, not in the agent definition.
3. The task `prompt`: the job. The agent does not see the caller's
   conversation, so make it self-contained: goal, paths, facts, and what
   to return.
4. Optional `context`: only where the run's trace is captured in cue.

When creating an agent for another project, put `cue-agent.json` (and any
prompt files) at that repo's root, and make sure the repo has an
`AGENTS.md`/`CLAUDE.md` describing how to work in it.

## Running

    cue-agent run '<JSON>'            # literal spec
    cue-agent run --spec spec.json    # from a file
    cue-agent run - < spec.json       # from stdin
    add --json for a machine-readable receipt, --timeout SECS to override

Spec envelope: `tasks` (required, 1-4), `defaults`, `label`, `job`.

    {
      "label": "Map the engine",
      "defaults": { "cwd": "/abs/path/to/repo",
                    "context": "<org>/<repo>/<context>" },
      "tasks": [
        { "agent": "explore", "prompt": "Where is session admission decided?" },
        { "agent": "explore", "model": "opus",
          "prompt": { "file": "question.md" } }
      ]
    }

Task fields: `agent` (required on each task), `prompt` (required after
defaults), `label`, `cwd` (absolute), `env` (overlay; `null` per variable
removes it), `context` (canonical address of an existing cue context),
`worktree` (`{ "base": "<rev>", "ephemeral": true|false, "path"?,
"branch"? }`), and overrides of `description`, `system_prompt`, `tools`,
`model`, `thinking`.

Rules that cause rejections:

- The whole batch is validated before anything runs; one bad task rejects
  all. Read the error: it names allowed models and agents.
- Prompts must not be empty or start with `-` or `@`.
- `model` must be in the agent's allowlist.
- No `timeout` field in specs; use the manifest or `--timeout`.

Exit code `0`: everything succeeded. `1`: the batch ran but a run failed,
timed out or was aborted, or a trace/record/cleanup failed (the receipt is
still printed). `2`: rejected before launch (bad spec, unknown agent,
invalid context, etc.); diagnostic on stderr, nothing on stdout.

## Monitoring and stopping

    cue-agent ps [--all] [--since 1h] [--limit N] [--job ID] [--json]
    cue-agent status <batch-id|run-id> [--json]
    cue-agent logs <run-id> [--stderr] [--follow]
    cue-agent stop <batch-id|run-id> [--wait] [--json]

A stopped run reports as aborted with "stopped by request".
