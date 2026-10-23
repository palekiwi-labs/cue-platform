# Fuzzy window picker for the container tmux (prefix w, C-f).
#
# Reads window user options set by other parts of the platform:
#   @pi_state, @pi_unseen, @pi_ctx   extensions/tmux-state.ts
#   @pi_desc                         extensions/tmux-resume.ts (/describe)
#   @review_state, @review_context,
#   @review_title, @review_run       cue-review
# tmux.conf colours the status-bar tabs from the same options.
#
# Rows are coloured like the tabs, show context tokens coloured like the
# pi footer, and preview the review or session description.

# Rows: id, coloured label (hidden id field used for preview).
tmux list-windows -F \
  '#{window_id}	#{@pi_state}	#{@pi_unseen}	#{window_active}	#{@pi_ctx}	#W	#{@review_state}	#{@review_context}	#{@pi_desc}' \
  | awk -F '\t' '{
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
      dv = ($9 != "") ? sprintf("  \033[2m%s\033[0m", substr($9, 1, 60)) : "";
      printf "%s\t%s %s%s\033[0m%s%s%s\n", $1, mark, c, $6, dv, pct, rv;
    }' \
  | fzf --ansi --reverse --no-sort --delimiter '\t' \
      --with-nth 2 --nth 1 \
      --prompt "$(tmux display-message -p '#S')> " \
      --preview "tmux display-message -p -t {1} '#{?@review_context,#{@review_title} | #{@review_context} | run #{?@review_run,#{@review_run},pending} | #{?@review_state,#{@review_state},pending},#{@pi_desc}}'" \
      --preview-window 'down,3,wrap' \
  | cut -f1 \
  | xargs -r tmux select-window -t
