# cue CLI Reference

The `cue` command-line tool manages file-based context and memory artifacts in
the central store at `$CUE_STORE` (default `~/cue`). Per-repository `.cue/`
stores are abolished. Cue writes nothing into the project working tree.

Repository scope is derived from `git remote get-url origin` (`<org>/<repo>`).
Context resolution order:

`--context <slug>` > `$CUE_CONTEXT` > `git config branch.<branch>.cue-context` > unset.

When context is unset:
- **Reads widen to repository scope** (e.g. `cue list` lists artifacts across all
  contexts in the repository).
- **Writes fail with an error.** Cue has no default or fallback context.

Agents must pass `--context <slug>` explicitly on all operations and avoid mutating
git branch configurations.

## Global Options

- `-C <PATH>`, `--dir <PATH>`: Run as if started in `<PATH>` instead of the current
  directory (mirrors `git -C`; derives scope from origin remote of `<PATH>`).
- `--store <PATH>`: Root of the central cue store; overrides `$CUE_STORE`.

## Primary Commands

### `cue status`
Prints the active context metadata (slug, title, kind, mode, scope, store).

```bash
cue status
cue status --context <slug>
cue status --json
```

### `cue context`
Manages context containers and branch associations.

#### `cue context create`
Creates a context in the repository's central store scope.

```bash
cue context create <NAME> [OPTIONS]
```

**Flags:**
- `--title <TITLE>`: Presentation name.
- `--kind <KIND>`: What ends this context (`work` [default], `coord`, `reference`).
- `--mode <MODE>`: Advisory session mode (`research`, `design`, `build`, `review`, `learn`).
- `--description <DESC>`: One-line listing description.
- `--parent <PARENT>`: Canonical address of parent context (e.g. `palekiwi/palekiwi/cue-platform-direction`).
- `--ref <REF>`: Canonical address of related context or artifact (repeatable).

#### `cue context list`
Lists context slugs in the current repository scope.

```bash
cue context list
cue context list --json
```

#### `cue context switch`
Associates a context with a Git branch (`git config branch.<name>.cue-context`).
Reserved for the human operator; agents should not switch branch context.

```bash
cue context switch <SLUG>
cue context switch <SLUG> --branch <BRANCH>
```

#### `cue context unset`
Removes a context association from a Git branch.

```bash
cue context unset
cue context unset --branch <BRANCH>
```

### `cue list`
Queries, lists, and filters artifacts across context scopes. Always prefer `cue list`
over raw filesystem search.

```bash
cue list [OPTIONS]
```

**Key Flags:**
- `--context <CONTEXT>`: Target a specific context. When omitted, widens across
  all contexts in the repository scope.
- `--type <TYPE>`, `-t <TYPE>`: Filter by artifact category (`task`, `spec`, `plan`,
  `note`, `trace`, `review`, `bin`, `tmp`). Repeatable to match any selected type.
- `--filter <EXPR>`: Filter by frontmatter field (repeatable, ANDed).
  Syntax: `KEY=VALUE`, `KEY!=VALUE`, `KEY~=SUBSTRING`. Dot notation supported (`meta.status=open`).
- `--frontmatter`: Parse and include YAML frontmatter in JSON output (implies `--json`).
- `--json`, `-j`: Output as JSON array of `CueFile` objects.

**Common Query Examples:**
```bash
# List all tasks in a context
cue list --context auth-redesign --type task

# List all tasks across the entire repository scope
cue list --type task

# Find open/in-progress tasks across repository
cue list --type task --filter "status!=complete" --filter "status!=closed"

# Find child tasks of a parent
cue list --type task --filter "parent=palekiwi/palekiwi/auth-redesign/task/login.md"

# Find high priority items with parsed frontmatter
cue list --context auth-redesign --type task --filter "priority=high" --frontmatter

# Search artifacts across another repository
cue list -C /path/to/other/repo --type task
```

### `cue add`
Creates a new memory artifact in the active or specified context.

```bash
cue add [OPTIONS] <FILENAME> [CONTENT]
```

**Key Flags:**
- `--context <CONTEXT>`: Context slug to write into (required; cue has no fallback context).
- `--type <TYPE>`, `-t <TYPE>`: Type of artifact (`spec` [default], `task`, `plan`,
  `note`, `trace`, `review`, `bin`, `tmp`).
- `--file <FILE>`: Read content from a file (recommended for AI agents to avoid escaping issues).
- `-f <KEY=VALUE>`, `--frontmatter <KEY=VALUE>`: Metadata fields (repeatable,
  `KEY=VALUE`). Cue is the sole writer. Markdown types carry them as a YAML
  frontmatter block; `review` merges them as top-level keys of the JSON
  object; `bin` refuses metadata — an executable carries none.
- `--force`: Overwrite existing file.

Type-specific write behaviour: `review` requires a JSON object (extensionless
names get `.json`) and is never prepended with frontmatter; `bin` stores the
supplied bytes verbatim, keeps the filename exactly as given, and marks the
file executable; `tmp` writes into a fresh
`tmp/<created_at>-<commit_hash>/` directory.

### `cue render`
Renders artifacts as framed blocks for injection into an agent session.

```bash
cue render --context <slug> spec/index.md plan/index.md
```

### `cue log`
Manages project log entries (`log/<timestamp>.json`).

#### `cue log add`
Appends a structured history entry to the context log.

```bash
cue log add --context <slug> --title "Summary" [OPTIONS]
```

**Flags:**
- `--title <TITLE>`: Entry title (required unless `--file` is used).
- `--context <CONTEXT>`: Target context slug.
- `--trace <TRACE>`: Context-relative (`trace/<name>.md`) or canonical address to a trace.
- `--found <FOUND>`: Findings (repeatable).
- `--decided <DECIDED>`: Architectural decisions (repeatable).
- `--open <OPEN>`: Open questions (repeatable).
- `--file <FILE>`: Read entry data from a JSON file.

#### `cue log list`
Lists rendered log entries for a context.

```bash
cue log list --context <slug> --format md --limit 5
cue log list --context <slug> --format json
```
