# Runs cue-review.nu with signal handling nu lacks, and publishes
# @review_state (running/ok/failed) on the tmux window for the statusline
# and window picker.
#
# nu has no signal trap: on Ctrl-C it aborts with exit 1. This wrapper
# records SIGINT and maps the exit to 130. cue-agent receives the same
# SIGINT and cleans up its own runs.

set_review_state() {
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    tmux set -q -w "@review_state=$1" 2>/dev/null || true
  fi
}

set_review_state running
interrupted=0
trap 'interrupted=1' INT TERM
rc=0
cue-review-nu "$@" || rc=$?
if [ "$interrupted" = 1 ]; then
  echo "cue-review: interrupted; no further phases started" >&2
  set_review_state failed
  exit 130
fi
state=$([ "$rc" = 0 ] && echo ok || echo failed)
set_review_state "$state"
exit "$rc"
