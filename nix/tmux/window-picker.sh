# Fuzzy window picker for the container tmux (prefix w, C-f).
# Lists windows running pi (@pi_state set); ctrl-a toggles to the other
# windows, without a preview.
#
# Reads window user options set by other parts of the platform:
#   @pi_state, @pi_unseen, @pi_ctx   extensions/tmux-state.ts
#   @pi_desc                         extensions/session-describe.ts
#   @pi_last                         extensions/tmux-state.ts
#   @review_state, @review_context,
#   @review_title, @review_run       cue-review (row-level only)
# tmux.conf colours the status-bar tabs from the same options.
#
# Rows are coloured like the tabs, show context tokens coloured like the
# pi footer, an age marker (time since the last completed turn) and the
# session description. The preview pane repeats the row info plus the
# last user prompt (@pi_prompt).

# Preview: window description plus recent turns from the session file
# (@pi_session, published by extensions/tmux-state.ts), one line per
# message, user/agent like the built-in session tree.
if [ "${1:-}" = preview ]; then
  shift
  sess=$(tmux display-message -p -t "$1" '#{@pi_session}')
  if [ -n "$sess" ] && [ -f "$sess" ]; then
    python3 - "$sess" <<'PY'
import json, sys

entries = []
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except ValueError:
            pass

index = {e.get("id"): e for e in entries if e.get("id")}
chain = []
cur = entries[-1] if entries else None
while cur is not None:
    chain.append(cur)
    cur = index.get(cur.get("parentId"))
chain.reverse()

msgs = []
for e in chain:
    if e.get("type") != "message":
        continue
    m = e.get("message") or {}
    role = m.get("role")
    if role not in ("user", "assistant"):
        continue
    c = m.get("content")
    text = c if isinstance(c, str) else next((p.get("text", "") for p in c or [] if isinstance(p, dict) and p.get("type") == "text"), "")
    text = " ".join(text.split())
    if not text:
        continue
    msgs.append((role, text))
for role, text in msgs[-12:]:
    text = text[:80]
    label = "user:  " if role == "user" else "agent: "
    lc = "\033[35m" if role == "user" else "\033[34m"
    print(f"{lc}{label}\033[0m\033[2m{text}\033[0m")
PY
  else
    tmux display-message -p -t "$1" '#{@pi_prompt}' | fold -s -w 76
  fi
  exit 0
fi

# Rows: id, coloured label (hidden id field used for preview).
rows() {
tmux list-windows -F \
  '#{window_id}	#{@pi_state}	#{@pi_unseen}	#{window_active}	#{@pi_ctx}	#W	#{@review_state}	#{@review_context}	#{@pi_desc}	#{@pi_last}' \
  | awk -v now="$(date +%s)" -v other="$1" -F '\t' '(other != "") == ($2 == "") {
      c = "";
      if ($7 == "failed") c = "\033[31m";
      else if ($7 == "running") c = "\033[33m";
      else if ($7 == "ok") c = "\033[32m";
      else if ($2 == "blocked") c = "\033[31m";
      else if ($2 == "working") c = "\033[33m";
      else if ($3 == "1") c = "\033[32m";
      mark = ($4 == "1") ? "*" : " ";
      # Context tokens, formatted and coloured like the pi footer
      # (cue thresholds: 80k caution, 100k soft, 140k hard).
      pct = "";
      if ($5 != "") {
        n = $5 + 0;
        if (n < 1000) t = n;
        else if (n < 10000) t = sprintf("%.1fk", n / 1000);
        else if (n < 1000000) t = sprintf("%dk", int(n / 1000 + 0.5));
        else t = sprintf("%.1fM", n / 1000000);
        pc = "\033[37m";
        if (n >= 140000) pc = "\033[1;31m";
        else if (n >= 100000) pc = "\033[31m";
        else if (n >= 80000) pc = "\033[33m";
        pct = sprintf("  %s%s\033[0m", pc, t);
      }
      rv = ($8 != "") ? sprintf("  \033[2m%s\033[0m", $8) : "";
      # Session description, dimmed right after the window name.
      dv = ($9 != "") ? sprintf("  \033[2m%s\033[0m", $9) : "";
      # Age since the last completed turn, dimmed.
      av = "";
      if ($10 != "") {
        s = now - int($10 / 1000);
        if (s < 0) s = 0;
        if (s < 60) a = "now";
        else if (s < 3600) a = sprintf("%dm", int(s / 60));
        else if (s < 86400) a = sprintf("%dh", int(s / 3600));
        else a = sprintf("%dd", int(s / 86400));
        av = sprintf("  \033[2m%s\033[0m", a);
      }
      printf "%s\t%s %s%s\033[0m%s%s%s%s\n", $1, mark, c, $6, dv, pct, rv, av;
    }'
}

if [ "${1:-}" = rows ]; then
  rows "${2:-}"
  exit 0
fi

session=$(tmux display-message -p '#S')
pi_prompt="$session> "
other_prompt="$session (non-pi)> "
pi_preview='down,60%,wrap,nohidden'

rows "" \
  | fzf --ansi --reverse --no-sort --delimiter '\t' --info=inline \
      --with-nth 2 --nth 1 \
      --prompt "$pi_prompt" \
      --bind "ctrl-a:transform:if [ \"\$FZF_PROMPT\" = '$pi_prompt' ]; then echo 'change-prompt($other_prompt)+change-preview-window(hidden)+reload($0 rows other)'; else echo 'change-prompt($pi_prompt)+change-preview-window($pi_preview)+reload($0 rows)'; fi" \
      --preview "$0 preview {1}" --preview-window "$pi_preview" \
  | cut -f1 \
  | xargs -r tmux select-window -t
