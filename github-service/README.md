# cue-github

Standalone Node service for explicit GitHub repositories. No pi or station
runtime dependency. No JetStream or durable domain events. Pi and station
consume snapshots through the shared `src/client.ts` NATS client.
The dependency-free wire contract is `src/protocol.ts`, also exported as
`@palekiwi-labs/cue-github/protocol` after building. Clients can import its
types without loading the service, SQLite, TOML, or NATS dependencies.

## Package and development

From the cue-platform root:

```sh
nix develop --command bash -c 'cd github-service && npm ci --ignore-scripts'
nix develop --command bash -c 'cd github-service && npm run format:check && npm run build && npm run typecheck && npm test'
nix build .#cue-github --no-link
nix run .#cue-github -- --help
```

The standalone flake output is `packages.<system>.cue-github`; it is not
added to the default platform bundle. Its executable is `bin/cue-github`.
The wrapper supplies Node and gh. The package builds and runs its own
checks, including a local NATS server lifecycle test. It does not make
live GitHub requests. Node >=24 is required. The pinned devshell currently
provides Node 24.21.0 with built-in `node:sqlite` and SQLite 3.53.3.

## Read-only configuration

Provision `~/.config/cue/github.toml` externally:

```toml
repositories = ["spabreaks/spabreaks"]
poll_seconds = 120
concurrency = 2
cooldown_seconds = 15
stagger_seconds = 1
max_backoff_seconds = 1800
nats_url = "nats://127.0.0.1:4222"
```

Only `repositories` is required; all other values above are defaults.
Unknown keys, duplicate repositories and invalid scheduling values fail
startup. Repository names are normalized to lowercase. No discovery or
implicit repository is used. `--config PATH` overrides the config path.
`XDG_CONFIG_HOME` and `XDG_STATE_HOME` are respected. `CUE_NATS_URL`, when
nonempty, overrides `nats_url`. The service never writes configuration.

Private state is `~/.local/state/cue/github/snapshots.sqlite`, including
SQLite WAL sidecars. The directory is mode 0700, database mode 0600, and
the daemon uses umask 0077. Run one service instance as the owning VM user.
Do not expose or share the database as the client API. Removing state
changes `storeId`; clients must restart snapshot pagination on that change.
Removed configured repositories are no longer listed or polled, though
their old rows remain private in SQLite.

## Collection, health and scheduling

Collection invokes `gh api graphql` using inherited proxy environment.
For `spabreaks/*`, only the subprocess receives
`GH_TOKEN=PLACEHOLDER-gh-spabreaks`, matching the VM's existing egress proxy
credential mechanism. Other repositories inherit the caller's gh identity.
There are no stored credentials and no logged/persisted subprocess stderr.
`viewer` comes from GraphQL under the same credential as each repository,
not from a separately configured username. NATS URLs and credentials must
not be placed in diagnostics.

All open PR pages come from `repository.pullRequests`, not capped search
results. Labels and review-request connections are paginated too. User
review requests are preserved; team requests are ignored, matching pi's
current model. All pi PR fields plus `updatedAt` are retained. Each gh
subprocess has a 60-second timeout and 32 MiB output bound.

GraphQL errors (even with partial data), malformed/incomplete connections,
repeated cursors, duplicate PR numbers, changing counts or identity,
subprocess failures and cancellation reject the collection. A completed
collection replaces a repository snapshot in one SQLite transaction.
Errors retain the last good snapshot, viewer, revision and `fetchedAt`,
and update fetch health. An initially unfetched repository has revision 0,
null viewer/timestamps and an empty list, distinct from a successful empty
repository. A successful first empty collection advances to revision 1.

Revisions advance only when canonical PR data or viewer changes, not when
fetch health or timestamps change. PRs, labels and reviewers have canonical
ordering. Fetch health includes last attempt, last success, failure count
and a sanitized error. Time fields are Unix milliseconds; PR timestamps
are GitHub ISO strings.

Polling starts immediately with per-repository staggering, at most two
concurrent repository fetches by default. Refreshes coalesce with queued or
running fetches per repository. Successful attempts enforce cooldown;
failures enforce exponential backoff from the poll interval up to the
configured maximum. Manual requests do not bypass either. Polling and
SQLite continue independently while NATS is unavailable. On shutdown,
queued work completes with errors and running subprocesses are aborted.

GitHub does not offer a transaction across GraphQL pages. Count and cursor
checks reject detectable inconsistencies, but a concurrent edit with an
unchanged total may still yield a temporally mixed snapshot; a later poll
reconciles it.

## NATS API v1

Use core NATS request/reply with JSON objects. Every reply is either
`{ "ok": true, "data": ... }` or
`{ "ok": false, "error": { "code": "...", "message": "..." } }`.
Requests are bounded to 16 KiB. Replies exceeding the broker payload limit
return `response_too_large`; reduce the list limit. No shared queue group:
run only one responder for this namespace. Configure routing/ACLs for
`github.api.v1.*` and `github.evt.v1.*` explicitly, independent of agent
lifecycle subjects.

### `github.api.v1.list`

Request: `{ repo?, offset?, limit?, storeId?, revisions? }`.
Omitting `repo` selects all configured repositories. Default offset is 0;
limit is 1–100 (default 100).

Result: `{ storeId, repositories, prs, total, nextOffset }`.
`repositories` contains metadata for every selected repository even when
unfetched or when the PR page is empty. PR pagination is over the combined
configured-order repository list, with ascending PR numbers within each.
`nextOffset` is null on the last page. Each metadata record contains
`repo`, `revision`, `viewer`, `fetchedAt`, `attemptedAt`, `failures`, `error`.
The returned metadata and PR page are read synchronously from private state.

For subsequent pages, echo `storeId` and a `revisions` object mapping every
selected repo to its first-page revision. If either guard differs, the
reply is `conflict`: discard accumulated pages and restart. A health-only
change does not invalidate the data guard. Prefer per-repo pagination to
reduce retries on busy multi-repo installations.

### `github.api.v1.refresh`

Request: `{ repo? }`. Omit `repo` to refresh all configured repositories.
Result: `{ operationId }`, returned promptly without awaiting GitHub.
The operation can remain pending during cooldown or backoff. A new
operation may share repository fetches with other operations or polling.
Request retries can create separate operation IDs; they do not cause
parallel duplicate fetches of a repository.

### `github.api.v1.operation`

Request: `{ operationId }`.
Result: `{ operationId, createdAt, completedAt, state, repositories }`.
State is `pending` or `complete`. The repository map holds outcomes with
state `pending`, `success` (plus `revision` and `changed`), or `error`
(plus sanitized `error`). Completed operations expire after 15 minutes;
at most 256 pending/completed operations are retained, evicting oldest
completed first. If all capacity is pending, refresh returns `busy`.
Operation tracking is in-memory, not persistent across daemon restarts;
unknown/expired/evicted IDs return `not_found`. Reread snapshots to recover.

### Advisory notifications

- `github.evt.v1.changed`: `{ storeId, repo, revision }`, only after a
  changed repository snapshot commits. Polls may emit this without a
  refresh operation.
- `github.evt.v1.completed`: `{ operationId }`, after all repositories in
  an explicit refresh operation finish, including unchanged/error results.
  Query the operation for its outcomes.

These are lossy core NATS hints. They are neither durable events nor proof
of a consumer's state. No offline replay or JetStream outbox exists.
The service retries initial connections and resubscribes after connection
loss with capped backoff. Clients must list again after reconnect and
periodically reconcile revisions even without a notification.

## Consumers and deployment

Pi's PR browser and station read persisted snapshots on launch. Refresh
requests go through the service; neither consumer falls back to a GitHub
list fetch. Both retain displayed rows while refreshing and show an
indicator when background data has changed. Comments, reviews and diffs
still use their existing on-demand fetching paths.

The shared client collects all snapshot pages with revision guards and
bounded conflict retries. It tracks refresh operations by polling, so
completion does not depend on receiving a notification. Change/completion
hints, reconnects, and a 30-second reconciliation interval prompt revision
checks, not automatic replacement of the displayed rows. Closing a view
releases its client, subscriptions and timers. Expired operations report
an error; another refresh rereads service state.

Org views use the service's explicit repository configuration, filtered by
the view's orgs, rather than discovering repository directories in cue.
Viewer-dependent presets and review markers use each repository's identity.

Station no longer prunes worktrees on list load: cached data is not safe
proof that a PR is closed. `station clean` requires a successful service
refresh before pruning.

Nix-config owns the VM unit, generated TOML and explicit NATS routing.
Input updates and deployment require operator approval. Operator QA still
needs deployed VM startup/restart, proxy-backed polling and both UI flows.
No JetStream replay or automated workflow triggers are installed.
