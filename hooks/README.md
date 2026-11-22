# cue hooks

Executables run by cue after store writes (cue with hooks support). cue
discovers hooks in `$CUE_CONFIG_DIR/hooks/all.d/` (every event) and
`$CUE_CONFIG_DIR/hooks/<event>.d/` (one event); the config dir defaults
to `~/.config/cue`.

## nats-publish

Publishes every hook event to NATS, core publish, fire and forget:

    cue.evt.v1.<base64url(context address)>.<event>

The body is the hook payload plus `context`, `type`, `title`,
`origin_session` (`$PI_SESSION_ID`, else null), `parent_event_id`,
`root_event_id` and `depth`; artifacts may add `status`, contexts `kind`,
log entries `trace`. Lineage is also sent as the headers
`Cue-Root-Event-Id`, `Cue-Parent-Event-Id` (omitted at the root) and
`Cue-Depth`.

Requires `bash`, `jq`, the `nats` CLI and `cue` on PATH (`nats` falls
back to `/run/current-system/sw/bin/nats`; `$CUE_BIN` overrides `cue`).
It finishes in well under the 3 s hook timeout; the publish itself is
capped at 2 s. The server is
`$CUE_NATS_URL`, default `nats://127.0.0.1:4222`. A failed publish exits
non-zero; cue keeps the write and records the stderr tail in
`$XDG_STATE_HOME/cue/hooks.jsonl`.

Install by symlink:

    mkdir -p ~/.config/cue/hooks/all.d
    ln -s "$PWD/hooks/nats-publish" ~/.config/cue/hooks/all.d/10-nats-publish

Watch the traffic:

    nats sub 'cue.evt.v1.>'

Test against a running server (`$CUE_NATS_URL`):

    tests/nats-publish.sh
