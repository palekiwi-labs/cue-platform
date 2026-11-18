# GitHub feedback

Station shows the feedback a pull request received on GitHub in the
`github` tab of an opened PR (key `4`). The data comes from a read-only
snapshot produced on demand; station never posts, resolves or edits
anything on GitHub.

## Fetching a snapshot

```sh
station github-feedback <number>                  # print JSON to stdout
station github-feedback <number> --repo owner/name
station github-feedback <number> --out feedback.json
station github-feedback <number> --save           # write where the tab reads it
```

Without `--repo` the repository is the GitHub `origin` of the current
checkout. Requests go through `gh api graphql`, so authentication, host
and rate limits follow the local `gh` configuration. From a source
checkout, run `npm run build` and `node bin/station.js github-feedback ...`.

`--save` writes `~/.cache/station/github-feedback/<owner>-<repo>-pr-<n>.json`
(owner and repo lowercased), the same file the tab writes after `R`.

Every connection is paginated: review threads (50 per page), comments
inside each thread (100 per page, followed per thread), PR comments and
reviews (100 per page). A missing or repeated cursor, a GraphQL error or
a missing pull request fails the whole fetch; no partial snapshot is
written.

## Snapshot shape (`station/github-feedback@1`)

- `fetched_at`, `source` (`github-graphql`), `repo`
- `pr`: number, title, url, state, draft flag, author, head and base
  refs, and `head_sha` / `base_sha` at fetch time.
- `threads`: review threads in GitHub order, each with `path`,
  `subject_type` (`LINE` or `FILE`), `diff_side` / `start_diff_side`
  (`RIGHT` new side, `LEFT` old side), `line` / `start_line` (in the
  current diff, null when outdated), `original_line` /
  `original_start_line` (in the diff of the commit the thread was made
  on), `is_resolved`, `resolved_by`, `is_outdated`, `is_collapsed`,
  `comments_total` and its `comments`.
- Thread comments keep their GitHub ids (`id`, `database_id` as a
  string), author login, type and association, body, state (`PENDING`
  for the viewer's unsubmitted comments), timestamps, url, minimized
  state, `reply_to`, review id and state, `commit`, `original_commit`,
  line fields, `outdated` and the captured `diff_hunk`.
- `conversation`: PR comments and review bodies in time order, with
  `kind` (`comment` or `review`), review `state` and `commit`.
  Reviews without a body are kept only for `APPROVED`,
  `CHANGES_REQUESTED` and `DISMISSED`; pending reviews and empty
  `COMMENTED` reviews (containers for thread comments) are counted in
  `omitted_reviews`.

## The tab

- Entering the tab loads the saved snapshot only; it never fetches.
- `R` fetches from GitHub and saves. While fetching the previous
  snapshot stays visible; a failed fetch keeps it and shows the error.
- The sidebar lists code threads, then the general conversation. Each
  entry takes two rows and shows no comment text. A thread shows its
  file and line (long paths keep their tail), then its `resolved` /
  `outdated` state, the first comment's author and the comment count.
  A general entry shows its type (`PR comment`, `review`, `review
  approved`, `review changes requested`, `review dismissed`), then
  `hidden` when minimized, its author and the comment count.
  `j`/`k`, arrows or `ctrl+up`/`ctrl+down` select, `g`/`G` jump,
  scrolling keys as elsewhere.
- `t` hides the sidebar so the detail uses the full width; `t` again
  shows it.
- `s` picks a sort: GitHub order (default), newest activity first,
  unresolved threads first (then newest), or file and line. General
  comments have no resolved state: they are listed newest first under
  the newest and unresolved sorts and oldest first otherwise. The sort,
  the selection and the sidebar state are kept across `R`.
- `y` copies the GitHub link of the selected thread (its first comment)
  or general comment to the clipboard (OSC 52, as elsewhere in station).
- The detail shows the thread location, resolved and outdated state,
  the captured diff (commented lines marked) and every comment with
  author and time. The diff side is not shown; it is only used to open
  the thread at the right revision.

## Opening a thread (`e`)

The editor opens at a revision and line resolved from the thread, never
at a guessed one:

- Current new-side threads open at the snapshot's PR head on `line`.
- Outdated new-side threads open at the commit the thread was made on
  (`original_commit`) on `original_line`.
- Old-side threads open at the merge-base of that commit and the PR
  base, following a rename back to the old path.
- The commented line in the captured diff hunk must match the file at
  that revision. Old-side threads require the hunk, since the merge-base
  is derived locally.
- File-level comments open line 1 of the file at the resolved revision.

Missing commits are fetched from `origin` first. The PR head opens in
the PR's review worktree; any other revision uses the PR's
`pr-<n>-findings` worktree, which is moved only when clean. A file with
local changes asks before opening. When a location cannot be resolved
the reason is shown and the captured diff stays available in the
detail. General comments have no location and cannot be opened.
