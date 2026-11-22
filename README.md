# cue-platform

The cue-centered agent environment: the tools inside cast containers,
and cast with its terminal UI on the host.

cue-platform ships in three parts:

- **The flake** builds the tools: pi, cue, cue-agent, cast-mcp-client,
  cue-review, cue-recall, gh, jq, the container tmux (with its window
  picker) and the nvf-based nvim. `packages.<system>.default` bundles all of them; each
  is also exported on its own.
- **The host tools**: cast (re-exported from the cast flake) and
  cast-tui (`cast-tui/`), the terminal UI that bare `cast` opens; it
  lists cast instances and hosts the GitHub PR picker (see
  `cast-tui/README.md`).
  `packages.<system>.host` bundles both; each is also exported on its
  own.
- **The pi package** (this repository: `extensions/`, `src/pi/`,
  `skills/`, `prompts/`) adds cue integration to pi. It is installed with
  pi's own package manager, not through nix.

The container bundle and the pi package run inside cast containers;
the host bundle runs on the machine that starts them. The cast version
is the one in cue-platform's lock file.

## Install

### 1. Tools: add the flake to the cast shell

In the cast flake (`~/.config/cast/nix/flake.nix`):

```nix
inputs.cue-platform = {
  url = "github:palekiwi-labs/cue-platform";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

and add `inputs.cue-platform.packages.${system}.default` to the shell's
package list.

Keep `inputs.nixpkgs.follows`. With it, cue-platform and its own inputs
(cue, cast) build against your nixpkgs, so shared packages
such as tmux, gh and jq are the same versions as the rest of your shell.
Without it they come from cue-platform's lock file. Pi is provided by
nixpkgs's `pi-coding-agent` (currently 1.5.2), not llm-agents. A consumer
that follows its own nixpkgs must provide that version too, or it can get a
different Pi version than the development dependencies. The nvim build
keeps nvf's own nixpkgs either way.

The flake no longer exports an `llm-agents` input. Consumers using other
llm-agents packages must declare that input independently rather than
following `cue-platform/llm-agents`.

### 2. Pi package

```sh
pi install git:github.com/palekiwi-labs/cue-platform
```

Update both parts together, so the extensions match the pi the flake
pins:

```sh
nix flake update cue-platform
pi update --extension git:github.com/palekiwi-labs/cue-platform
```
`~/.pi` is shared by every cast sandbox, so this is done once.

### 3. Host tools

Install `inputs.cue-platform.packages.${system}.host` on the host (for
example in home-manager's `home.packages`). It provides `cast` and
`cast-tui`; running `cast` with no command opens cast-tui.

## Developing cue-platform

Point both parts at the checkout instead of GitHub. The checkout must be
mounted at the same path in every container.

Flake input, in the cast flake:

```nix
inputs.cue-platform = {
  url = "git+file:///home/pl/code/palekiwi-labs/cue-platform";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

The flake is copied into the nix store: after changing it, stage new
files (`git+file` ignores untracked ones, and `node_modules`), commit,
and refresh cast's input:

```sh
nix flake update cue-platform --flake ~/.config/cast/nix
```

then restart cast, or re-enter the shell.

Pi package, loaded live from the checkout:

```sh
pi install /home/pl/code/palekiwi-labs/cue-platform
```

This adds the local path to `~/.pi/agent/settings.json`. Extension edits
need no rebuild: `/reload` picks them up, as do new pi processes.

Do not also register the old `cue-plugins` or `pi-extensions` packages:
both versions would register duplicate tools, commands and handlers.

## Cue integration

`src/pi/index.ts` registers the cue artifact tools, `cue-recall`,
`delegate`, context orientation commands (`/cue:context:current`, `/cue:context:inject`,
`/cue:context:pins`), `/cue:idea`, and `/review:run`. It also supplies cue skill
injection, the footer, session naming, Acuity idle reporting, and the cast
MCP adapter.
`prompts/pi/` supplies `/cue:init`; `skills/` contains the nine cue skills.
`extensions/` holds tmux-state and session-describe
(`/describe`). Sessions are browsed in the cue browser (ctrl+r).

The extensions call cue, cue-agent, cue-recall, git and tmux from PATH;
the flake bundle provides all but git.

`cue-recall` searches only the default cue query scope of the session's
repository (`cue context list`) and ranks candidates with jev, so it
needs `TYPESAFE_API_KEY` in the environment; without it the tool fails
with that message.
`ACUITY_HOST` selects the observability endpoint. The MCP adapter discovers
cast through `cast-mcp-client`; outside cast it remains inactive.

## Configuration

Settings are read from `$XDG_CONFIG_HOME/cue-platform/cue-platform.json`
(default `~/.config/cue-platform/cue-platform.json`) at every session
start, including `/reload`. The file is optional; missing or invalid
values fall back to the built-in ones, and problems are shown as a
warning.

```json
{
  "context": {
    "thresholds": { "caution": 80000, "soft": 100000, "hard": 140000 }
  }
}
```

`context.thresholds` are the default context saturation limits used by
`cue-context-usage`, the `cue-log` note and the footer. `/thresholds`
overrides them for one session; the override is stored in the session
transcript, so it survives resume, and `r` in the popup resets to the
configured defaults.

Pi imports are supplied by the running harness; development dependencies
pin its types to the packaged version.

## Speech transport

Pi speech defaults to live core NATS publications through the local leaf at
`nats://127.0.0.1:4222`; `CUE_NATS_URL` overrides that address. The host
must route `speech.intent.>` from AGENT to HOST and run the utterance-aware
speech bridge. There is no HTTP fallback and no offline speech queue.

After updating the local checkout, use `/reload` or start a new pi process.
Enable live speech in session settings (F3). Alt+x and `/speech-stop` stop
all host speech, including clipboard playback, even when session speech is
off. A disconnected stop is dropped; use the host emergency stop if needed.

Live chunks share an utterance ID and contiguous sequence numbers starting
at zero. Message completion sends an empty final chunk; cancellation closes
the local utterance and sends global stop without a delayed second stop.
Whole-message sends use a fresh utterance and finalize it. Text is split to
1000 Unicode characters and checked against the bridge's 8192-byte JSON
limit. One persistent client serves the extension and closes on shutdown.

Streamed text is cut into chunks at sentence ends, paragraph breaks and
Markdown block starts (headings, list items, quotes, table rows, fences);
a line end inside a paragraph is a soft wrap and never a cut. A cut that
depends on text not yet received waits for it: the next line's marker, or
the first character after a sentence end. Before sending, heading markers
and setext underlines are dropped (Kokoro reads `#` as "number") and
ordered list items carry the number Markdown renders, so a list written
as repeated `1.` is read as one, two, three. Everything else is sent as
written.

Each session picks its Kokoro voice in session settings (F3): Bella
(`af_bella`, the default), Heart (`af_heart`), Jessica (`af_jessica`), Sky
(`af_sky`), Isabella (`bf_isabella`) or Echo (`am_echo`). The choice is kept
in the session, so it survives resume and reload. The voice is fixed when a
message starts and sent as `voice` on every chunk of its utterance, the empty
final chunk included; a change applies from the next message. Pi does not
queue or serialize utterances across sessions.

Publications never await bridge acknowledgements. Connected publication is
not proof of playback: holds, queue limits and stale IDs can reject speech;
inspect host `speech.evt.rejected` events for these failures. A failed local
publication drops the rest of that utterance; only a new message can retry.

For temporary legacy use only, start pi with `CUE_SPEECH_TRANSPORT=http`.
`CUE_SPEECH_URL` then overrides the HTTP bridge address. An explicit `url`
in the extension options also selects HTTP unless `transport` is `nats`.
The HTTP sender retains its existing delayed-stop race workaround; the
NATS sender never uses it. Do not use HTTP to circumvent coordination.
The HTTP sender sends only the text: the HTTP bridge speaks with its own
configured voice and ignores the session voice.

## Session subscriptions

A pi session subscribes to events about the store subjects it works on.
Subscriptions are derived from session state: linking a cue context
subscribes to `cue.evt.v1.<base64url-context>.>`; relinking or switching
the tree moves the subscription and discards pending events. The footer
shows `N sub(s)` while subscribed, and `/subscriptions` lists each
subscription with its subject, event count and time of the last event.

Events arrive on core NATS (`$CUE_NATS_URL`, default
`nats://127.0.0.1:4222`); there is no replay. On the next idle-session user
message pi inserts a visible `<session-events>` block, one line per event,
tagged by actor (`[cue]` for store writes, `[operator]` for operator
actions). Writes made by the session itself are not echoed. Custom-message
runs and steering messages do not consume pending events.

Producers:

- `hooks/nats-publish`, a cue hook, publishes `artifact_create`,
  `context_create` and `log_entry_add`.
- The review station's findings view (`s` on a finding, choose a status,
  confirm with Enter) rewrites the verifier JSON, then publishes
  `artifact_update` with actor `operator` and a summary such as
  `F3 open -> dismissed`. This is a stopgap until cue publishes artifact
  updates itself. A publish failure shows a warning; the saved change
  stays.

## GitHub snapshot service

`github-service/` is a separately packaged Node service providing private
SQLite PR snapshots over core NATS. Build `.#cue-github` or run
`nix run .#cue-github -- --help`. It is not part of the default bundle.
See [the service README](github-service/README.md) for the read-only TOML
configuration, protocol and validation. Pi and station PR lists use its
NATS API; details and diffs keep their existing on-demand fetching paths.
The VM unit and declarative configuration live in nix-config, not here.

## cue hooks

`hooks/nats-publish` publishes cue store events (artifact, context and
log writes) to NATS; see `hooks/README.md` for the message and install.

## Validation

```sh
nix flake check
nix build .#default --no-link
nix build .#host --no-link   # also runs the cast-tui tests
nix develop --command bun install --frozen-lockfile
nix develop --command bun run typecheck
nix develop --command bun test ./src
nix develop --command python3 tests/live-footer.py
nix develop --command python3 tests/live-pr-preview.py
tests/nats-publish.sh   # needs a NATS server at $CUE_NATS_URL
```

The smoke test uses an isolated tmux server, temporary settings, and a copy
of the package. It changes a visible footer marker, checks `/reload`, opens
a second window, checks tmux idle/blocked transitions before and after
reload, and verifies settings remain writable. It does not call
a model, read user credentials, or modify the working checkout.

The PR preview smoke test uses fixture comments and the installed pi's real
key manager and overlay dispatch. It checks default scrolling, layout toggling
and resizing in both fullscreen and regular modes, without GitHub or a model.

Verified on `x86_64-linux` only. Other system outputs are provided to
match the cast flake but have not been runtime-tested.
