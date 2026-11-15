# Supervisor API v1

Run `cue-supervisor daemon` as the single supervisor for this state root and
NATS namespace. The existing local `run`, `cancel`, `reconcile` and
`finalize` commands remain available. Do not start multiple daemons on the
same namespace or state root. Runs are never relaunched on recovery.

Connection settings match the pi NATS extension: `CUE_NATS_URL` defaults to
`nats://127.0.0.1:4222`; `CUE_NATS_JS_DOMAIN` defaults to `pale` (empty means
no domain). NATS/JetStream must be reachable at daemon startup. Connection
or heartbeat publication failure terminates the daemon; systemd restarts
it. There is no direct-spawn fallback.

## Request/reply subjects

All requests and replies are JSON. Subjects are:

- `agent.supervisor.v1.submit`: `{ "requestId": "caller-unique-id",
  "spec": { "runs": [{ "cwd": "/absolute/path", "context": "my-context",
  "prompt": "Do the work" }] } }`. Optional run fields are `model`,
  `timeoutSec`, and `worktree` (boolean or `{ "base": "HEAD" }`). Returns
  `{ "batchId": "...", "runIds": ["..."] }`.
- `agent.supervisor.v1.cancel`: `{ "kind": "run", "runId": "..." }` or
  `{ "kind": "batch", "batchId": "..." }`. Returns the existing cancellation
  report (`requested`, `alreadyFinished`, `stopped`). Intent is persisted
  before systemctl stop; consult result for the final outcome.
- `agent.supervisor.v1.status` and `agent.supervisor.v1.result`: the same
  target shape as cancel. Both reconcile authoritative evidence and return
  `{ "runs": [{ "runId": "...", "state": "running", "result": null,
  "cleanup": null }] }`. States are `pending`, `running`, `finished`,
  `derived`, or `unknown`. Non-null result includes the terminal outcome,
  text, usage and partial/error evidence. Cleanup is independent.

Replies wrap the data as `{ "ok": true, "data": ... }` or
`{ "ok": false, "error": { "code": "...", "message": "..." } }`.
Codes include `invalid_request`, `not_found`, `conflict`, `request_failed`,
and `response_too_large`. Very large results must be read from run files;
responses never exceed the server's max_payload. This API is for trusted
local callers; server authorization is managed separately.

IDs must contain 1–200 ASCII letters, digits, underscores or hyphens.
Request IDs are retained with batch files indefinitely. Deduplication
compares normalized run specs, not JSON key ordering. Reusing an ID with
a different spec is a conflict. Every run needs its own absolute cwd and
explicit non-empty cue context; caller environments are not accepted.

## Acceptance, timeouts and availability

The batch record atomically stores request ID, normalized payload and all
run IDs before launch. Acceptance is persisted before the reply. A caller
request timeout, connection loss or server error is **not rejection**:
acceptance may already have happened. Retry submit with exactly the same
request ID and spec. Do not invent a new ID on timeout. A crash between
acceptance and launch can leave an unknown run, never an automatic relaunch.
Atomic rename protects against partial writes, not power loss.

The JetStream KV bucket `supervisors`, key `supervisor`, mirrors a heartbeat
`{ "v": 1, "updatedAt": 123, "api": "agent.supervisor.v1" }`, refreshed
every 5 seconds with a 15-second bucket TTL. Callers should bound connection
and KV reads, reject a missing or older-than-15-second heartbeat, then use
a bounded request timeout. NATS no-responders is an immediate availability
failure even if a recently stopped daemon's heartbeat has not expired.
Heartbeat is advisory, never proof of acceptance. Files are authoritative;
no KV records are used for deduplication or run outcomes.

## Validation

From this checkout's devshell:

```sh
bun run typecheck
bun test ./src
SUP_SYSTEMD=1 SUP_PI=1 bun test ./src/supervisor
bun tests/supervisor-nats.ts /path/to/cue-supervisor
```

The CLI integration test uses the real local leaf/JetStream service, an
isolated state root and a fake pi under real transient systemd units. It
covers submit, restart/retry deduplication, conflict, status, result, run
and batch cancellation, heartbeat and no-responders. All test daemons and
slices are stopped in finally cleanup. Evidence remains in its printed
`/tmp/sup-nats-*` directory.
