#!/usr/bin/env bash
set -euo pipefail

hook=$(cd "$(dirname "$0")/../hooks" && pwd)/nats-publish
nats_url=${CUE_NATS_URL:-nats://127.0.0.1:4222}
nats_bin=$(command -v nats || echo /run/current-system/sw/bin/nats)

work=$(mktemp -d)
trap 'kill "${sub_pid:-}" 2>/dev/null || true; rm -rf "$work"' EXIT

ctx_slug="hooktest-$$-$RANDOM"
context="acme/demo/$ctx_slug"
store=$work/store
mkdir -p "$store/$context/note" "$store/$context/log" "$work/dump"
printf -- '---\ntitle: Demo ctx\nkind: work\ncreated_at: 1\n---\n' \
  >"$store/$context/context.md"
printf -- "---\ntitle: 'It''s \"quoted\": yes'\nstatus: open\ncreated_at: 1\n---\nbody\n" \
  >"$store/$context/note/n1.md"
printf 'body\n' >"$store/$context/note/plain.md"
printf '{"timestamp":1,"title":"Log one","trace":null}\n' \
  >"$store/$context/log/01.json"

"$nats_bin" sub -s "$nats_url" "cue.evt.v1.>" --count 5 --dump="$work/dump" \
  >/dev/null 2>&1 &
sub_pid=$!
sleep 0.5

run() {
  local event=$1 address=$2 id=$3
  shift 3
  printf '{"v":1,"event":"%s","event_id":"%s","address":"%s","occurred_at":"2026-01-01T00:00:00Z","session_id":%s}' \
    "$event" "$id" "$address" "${SESSION_JSON:-null}" \
    | env -u CUE_HOOK_PARENT_EVENT_ID -u PI_SESSION_ID \
      CUE_STORE="$store" CUE_NATS_URL="$nats_url" CUE_HOOK_EVENT="$event" \
      CUE_HOOK_EVENT_ID="$id" CUE_HOOK_ROOT_EVENT_ID="${ROOT:-$id}" \
      CUE_HOOK_DEPTH="${DEPTH:-1}" "$@" "$hook"
}

run context_create "$context" e1
SESSION_JSON='"sess-1"' run artifact_create "$context/note/n1.md" e2 PI_SESSION_ID=wrong-session
run artifact_create "$context/note/plain.md" e3
ROOT=e1 DEPTH=2 run log_entry_add "$context/log/01.json" e4 \
  CUE_HOOK_PARENT_EVENT_ID=e3
run context_update "$context" e5 PI_SESSION_ID=not-the-origin

for _ in $(seq 50); do
  [ "$(ls "$work/dump" | wc -l)" -ge 5 ] && break
  sleep 0.1
done

messages=$(jq -s -c --arg ctx "$context" '
  map(select((.Data | @base64d | fromjson | .context) == $ctx))
  | map({subject: .Subject, headers: .Header,
         body: (.Data | @base64d | fromjson)})
  | sort_by(.body.event_id)' "$work"/dump/*.json)

subject="cue.evt.v1.$(printf '%s' "$context" | basenc -w0 --base64url | tr -d '=')"
failures=0
check() {
  if jq -e --arg subject "$subject" --arg ctx "$context" "$2" <<<"$messages" >/dev/null; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s\n' "$1"
    failures=$((failures + 1))
  fi
}

check "five messages" 'length == 5'
check "context_update and payload session" '.[4] | .subject == "\($subject).context_update"
  and .body.type == "context" and .body.kind == "work"
  and .body.title == "Demo ctx" and .body.origin_session == null'
check "context_create" '.[0] | .subject == "\($subject).context_create"
  and .body.type == "context" and .body.title == "Demo ctx"
  and .body.kind == "work" and .body.origin_session == null
  and .body.parent_event_id == null and .body.root_event_id == "e1"
  and .body.depth == 1 and .headers["Cue-Root-Event-Id"] == ["e1"]
  and .headers["Cue-Depth"] == ["1"]
  and (.headers | has("Cue-Parent-Event-Id") | not)'
check "artifact title and session" '.[1] | .subject == "\($subject).artifact_create"
  and .body.type == "note" and .body.title == "It'"'"'s \"quoted\": yes"
  and .body.status == "open" and .body.origin_session == "sess-1"
  and .body.context == $ctx and .body.v == 1
  and .body.occurred_at == "2026-01-01T00:00:00Z"'
check "artifact title falls back to filename" '.[2].body.title == "plain.md"'
check "log entry lineage" '.[3] | .subject == "\($subject).log_entry_add"
  and .body.type == "log" and .body.title == "Log one"
  and .body.parent_event_id == "e3" and .body.root_event_id == "e1"
  and .body.depth == 2 and .headers["Cue-Parent-Event-Id"] == ["e3"]
  and .headers["Cue-Root-Event-Id"] == ["e1"] and .headers["Cue-Depth"] == ["2"]'

if run artifact_create "$context/note/plain.md" e6 CUE_NATS_URL=nats://127.0.0.1:1 \
  2>/dev/null; then
  printf 'FAIL unreachable server exits non-zero\n'
  failures=$((failures + 1))
else
  printf 'ok   unreachable server exits non-zero\n'
fi

[ "$failures" -eq 0 ]
