# cast-tui

Terminal UI for cast. Bare `cast` opens it; it lists the cast instances
across all workspaces (`cast ps`) and refreshes every two seconds.

## Keys

Instance list:

- `up` / `down`: select an instance
- `r`: refresh now
- `P`: open the PR picker
- `q` / `ctrl+c`: quit

## PR picker

`P` opens the GitHub PR browser shared with the pi extension's
`/cue:prs`, full screen, in org view. It lists the open PRs of every
repository with a scope directory in the cue store
(`$CUE_STORE/<org>/<repo>`, default `~/cue`), grouped by repository with
stacked PRs as trees, and previews the selected PR's comments. `esc`
returns to the instance list. The line under the header lists the
picker's keys.

PR actions such as checkout run in the local clone of the PR's
repository. cast-tui looks for it under these roots, in order:

- `~/code/palekiwi`
- `~/code/palekiwi-labs`
- `~/code/spabreaks`
- `~/code/vendor`

For a repository `owner/name` it takes `<root>/<owner>/<name>`, or
`<root>/<name>` when the root's directory is named after the owner
(`~/code/palekiwi-labs/cue-platform` for `palekiwi-labs/cue-platform`).

Built-in actions, available on every PR row:

- `ctrl+o`: check the PR out (`alt+w` toggles between a
  `worktrees/<branch>` worktree and the clone root)
- `ctrl+y` / `ctrl+h`: copy the PR URL / title
- `alt+a`: approve with `lgtm` (`gh pr review --approve --body lgtm`),
  after a `y` confirmation
- `alt+m`: request a review from `palekiwi` (`gh pr edit
  --add-reviewer palekiwi`)

The picker needs `gh` authenticated on the host.

## Per-repository actions: cast-tui.json

A `cast-tui.json` at the root of a repository's local clone adds
commands to the picker for that repository's PRs:

```json
{
  "prActions": [
    {
      "key": "alt+d",
      "label": "deploy staging",
      "command": "task deploy:staging",
      "confirm": true
    }
  ]
}
```

Each entry of `prActions`:

- `key`: the key chord, as pi-tui names it (`d`, `alt+d`, `ctrl+d`).
  Plain letters are taken before the search input, so they can no
  longer be typed into the filter; prefer `alt+` chords.
- `label`: shown in the key hints and the footer.
- `command`: run with `sh -c` in the clone root.
- `confirm` (optional, default `false`): ask `y` before running.

Commands see the selected PR in their environment:

- `PR_NUMBER`: the PR number
- `PR_URL`: the PR's GitHub URL
- `PR_BRANCH`: the PR's head branch
- `PR_REPO`: `owner/name`

The last line of the command's output (stdout and stderr) is shown in
the footer, together with the exit code on failure.

The file is read the first time a PR of the repository is selected
after opening the picker; reopen the picker to pick up changes. A
repository without a local clone, without the file, or with a malformed
file gets no extra actions.

## Development

The picker sources live in the pi package (`src/pi/prs`,
`src/pi/browser`). `npm run sync` copies them into `src/picker/`
(ignored by git); `npm run build` and `npm test` run it first.

```sh
nix develop --command sh -c 'cd cast-tui && npm ci && npm test'
nix build .#cast-tui --no-link   # builds and runs the tests
```
