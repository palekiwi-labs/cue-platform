# GitHub feedback

Station shows the feedback a pull request received on GitHub in the
`github` tab of an opened PR (key `4`). The data comes from the GitHub
service (`github-service`, `cue-github`) over NATS: review threads, PR
comments and review bodies it collects per open PR. Station never posts,
resolves or edits anything on GitHub, and it never calls GitHub for this
tab itself.

## Data source

- Entering the tab reads the service's feedback snapshot of the PR
  (`github.api.v1.feedback`). This is a read from the service store; it
  makes no GitHub call.
- `R` asks the service to refetch the feedback of this PR from GitHub
  (`github.api.v1.refresh` with the repository and PR number), waits for
  the operation and then reads the snapshot again.
- The service collects feedback on its own whenever a PR's `updatedAt`
  changes, so the snapshot is usually current without `R`.
- The repository is the GitHub `origin` of the checkout, lowercased as in
  the service configuration. A PR that is not in the service's open list
  for a configured repository reports the service's `not_found` error.
- The NATS server is `CUE_NATS_URL` (default `nats://127.0.0.1:4222`), as
  for the PR list. The PR list and the PR tabs opened from it share one
  service client; `station pr <n>` opens its own.

See `github-service/README.md` for the snapshot fields (camelCase, the
diff hunk kept once per thread with a per-comment override only where a
comment's hunk differs), collection scheduling and rate limits.

## Status and errors

The status bar (or the notice when there is no data yet) shows:

- `refreshing through GitHub service…` while a refresh is pending, or
  `refresh waiting: GitHub rate limited until <time>` while the service
  holds it for a rate-limit pause.
- Errors from the service, e.g. `GitHub service: GitHub service
  connection unavailable` when the service cannot be reached, or
  `refresh failed: <error>` when the refresh operation failed. A failed
  refresh keeps the previous data visible and also shows the error in a
  popup.
- `last GitHub fetch failed: <error>` when the service's last fetch for
  the PR failed; the data shown is the last good snapshot.
- `GitHub rate limited until <time>` while the service is paused.
- `new feedback available · R refresh` when a `github.evt.v1.feedback`
  event announces a newer revision (or a reset service store) for this
  PR. The displayed data is not replaced until `R`, as in the PR list,
  where the change indicator also points to the refresh key.

Without collected feedback yet the tab says so and offers `R`.

## The tab

- Entering the tab reads the service snapshot only; it never refreshes.
- `R` refreshes through the service. While it is pending the previous
  data stays visible; a failure keeps it and shows the error.
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
- `s` picks a sort: unresolved threads first, then newest (default),
  GitHub order, newest activity first, or file and line. General
  comments have no resolved state: they are listed newest first under
  the newest and unresolved sorts and oldest first otherwise. The sort,
  the selection and the sidebar state are kept across `R`.
- `y` copies the GitHub link of the selected thread (its first comment)
  or general comment to the clipboard (OSC 52, as elsewhere in station)
  and reports `link copied`. Links are kept in the snapshot but not
  shown in the tab.
- The detail shows the thread location, resolved and outdated state,
  the captured diff (commented lines marked) and every comment with
  author and time. The diff side is not shown; it is only used to open
  the thread at the right revision.

## Opening a thread (`e`)

The editor opens at a revision and line resolved from the thread, never
at a guessed one:

- Current new-side threads open at the PR head recorded in the service
  snapshot (`pr.headSha`) on `line`.
- Outdated new-side threads open at the commit the thread was made on
  (`originalCommit`) on `originalLine`.
- Old-side threads open at the merge-base of that commit and the PR
  base, following a rename back to the old path.
- The commented line in the captured diff hunk must match the file at
  that revision. The hunk is the thread's `diffHunk` unless the first
  comment carries its own. Old-side threads require the hunk, since the
  merge-base is derived locally.
- File-level comments open line 1 of the file at the resolved revision.

Missing commits are fetched from `origin` first. The PR head opens in
the PR's review worktree; any other revision uses the PR's
`pr-<n>-findings` worktree, which is moved only when clean. A file with
local changes asks before opening. When a location cannot be resolved
the reason is shown and the captured diff stays available in the
detail. General comments have no location and cannot be opened.
