# cue-platform

The cue-centered agent environment for cast containers.

## Bootstrap

The initial flake exports pi from `numtide/llm-agents.nix`, using the same
locked dependencies as the existing cast environment. It does not yet
bundle the cue CLI, configured tmux, or Neovim. Pi continues to load the
existing writable user configuration. The repository is also a native pi
package providing cue integration, skills, prompts, the footer, and tmux state.

```sh
nix develop
```

Outputs: `packages.<system>.pi`, `packages.<system>.default`, and
`devShells.<system>.default`.

## Cast development integration

The checkout must be mounted at the same path in each container. Our cast
flake uses:

```nix
inputs.cue-platform = {
  url = "git+file:///home/pl/code/palekiwi-labs/cue-platform";
  inputs.nixpkgs.follows = "nixpkgs";
};
inputs.llm-agents.follows = "cue-platform/llm-agents";
```

Use `inputs.cue-platform.packages.${system}.pi` in the shell package list.
The shared `llm-agents` input still supplies `agent-browser` and other tools.

After changing this flake, refresh cast's local input:

```sh
nix flake update cue-platform --flake ~/.config/cast/nix
```

A local flake input is still copied into the Nix store. It is not a live
extension source. For live extension development, register the checkout
separately as described below. The Git URL excludes ignored development
files such as `node_modules`; stage new files before evaluating the flake.

## Live pi package

Register the checkout with pi's native package manager:

```sh
pi install /home/pl/code/palekiwi-labs/cue-platform
```

This adds the local path to writable `~/.pi/agent/settings.json`. Pi loads
the package directly from the checkout. No wrapper, Nix rebuild, copied
configuration, or settings reset is needed for extension edits: `/reload`
picks them up, as do new pi processes using the same agent directory.
The flake alone does not yet install this package automatically.

Remove the old `cue-plugins` and `pi-extensions` package entries when
enabling this package. Loading both versions would register duplicate tools,
commands, footers, and event handlers. The original repositories remain
available for rollback; further development belongs here.

If `~/.agents/skills/cue*` symlinks point to cue-plugins, repoint those links
to the corresponding directories under this checkout's `skills/`. Otherwise
user-level skill discovery can keep using the old copies.

## Cue integration

`src/pi/index.ts` registers the cue artifact tools, `delegate`, context
orientation commands (`/cue:context:current`, `/cue:context:inject`,
`/cue:context:pins`), `/cue:idea`, and `/review:run`. It also supplies cue skill
injection, session naming, Acuity idle reporting, and the cast MCP adapter.
`prompts/pi/` supplies `/cue:init`; `skills/` contains the nine cue skills.

The cue CLI and cue-agent must remain on PATH (currently provided by cast).
`ACUITY_HOST` selects the observability endpoint. The MCP adapter discovers
cast through `cast-mcp-client`; outside cast it remains inactive.

Opencode adapters, dependencies, command templates, and prompt-parity tests
are not part of this repository. Pi imports are supplied by the running
harness; development dependencies pin its types to the packaged version.

## Validation

```sh
nix flake check
nix build .#pi --no-link
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

The bootstrap is verified on `x86_64-linux`. Other system outputs are
provided to match the existing cast flake but have not been runtime-tested.
