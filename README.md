# cue-platform

The cue-centered agent environment for cast containers.

cue-platform ships in two parts:

- **The flake** builds the tools: pi, cue, cue-agent, cast-mcp-client,
  cue-review, gh, jq, the container tmux (with its window picker) and the
  nvf-based nvim. `packages.<system>.default` bundles all of them; each
  is also exported on its own.
- **The pi package** (this repository: `extensions/`, `src/pi/`,
  `skills/`, `prompts/`) adds cue integration to pi. It is installed with
  pi's own package manager, not through nix.

Everything runs inside cast containers; nothing is meant for the host.

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
(cue, cast, llm-agents) build against your nixpkgs, so shared packages
such as tmux, gh and jq are the same versions as the rest of your shell.
Without it they come from cue-platform's lock file. The nvim build keeps
nvf's own nixpkgs either way.

If the shell also uses other llm-agents packages, share one copy:

```nix
inputs.llm-agents.follows = "cue-platform/llm-agents";
```

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

`src/pi/index.ts` registers the cue artifact tools, `delegate`, context
orientation commands (`/cue:context:current`, `/cue:context:inject`,
`/cue:context:pins`), `/cue:idea`, and `/review:run`. It also supplies cue skill
injection, session naming, Acuity idle reporting, and the cast MCP adapter.
`prompts/pi/` supplies `/cue:init`; `skills/` contains the nine cue skills.
`extensions/` holds the footer, tmux-state and tmux-resume.

The extensions call cue, cue-agent, git and tmux from PATH; the flake
bundle provides all but git.
`ACUITY_HOST` selects the observability endpoint. The MCP adapter discovers
cast through `cast-mcp-client`; outside cast it remains inactive.

Pi imports are supplied by the running harness; development dependencies
pin its types to the packaged version.

## Validation

```sh
nix flake check
nix build .#default --no-link
nix develop --command bun install --frozen-lockfile
nix develop --command bun run typecheck
nix develop --command bun test ./src
nix develop --command python3 tests/live-footer.py
```

The smoke test uses an isolated tmux server, temporary settings, and a copy
of the package. It changes a visible footer marker, checks `/reload`, opens
a second window, checks tmux idle/blocked transitions before and after
reload, and verifies settings remain writable. It does not call
a model, read user credentials, or modify the working checkout.

Verified on `x86_64-linux` only. Other system outputs are provided to
match the cast flake but have not been runtime-tested.
