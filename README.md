# cue-platform

The cue-centered agent environment for cast containers.

## Bootstrap

The initial flake exports pi from `numtide/llm-agents.nix`, using the same
locked dependencies as the existing cast environment. It does not yet
bundle cue, skills, configured tmux, or Neovim. Pi continues to load the
existing writable user configuration. The repository is also a native pi
package, currently providing the footer and tmux-state extensions.

```sh
nix run . -- --version
nix develop
```

Outputs: `packages.<system>.pi`, `packages.<system>.default`,
`apps.<system>.default`, and `devShells.<system>.default`.

## Cast development integration

The checkout must be mounted at the same path in each container. Our cast
flake uses:

```nix
inputs.cue-platform = {
  url = "path:/home/pl/code/palekiwi-labs/cue-platform";
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
separately as described below.

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

Remove the old `/home/pl/.agents/plugins/palekiwi/pi-extensions` package
entry from settings when enabling this package: both its footer and
`tmux-state` now live here. Loading both packages would register duplicate
footers and tmux event handlers. The original source is retained for
rollback; further development belongs here.

## Validation

```sh
nix flake check
nix build .#pi --no-link
nix run . -- --version
nix develop --command python3 tests/live-footer.py
```

The smoke test uses an isolated tmux server, temporary settings, and a copy
of the package. It changes a visible footer marker, checks `/reload`, opens
a second window, checks tmux idle/blocked transitions before and after
reload, and verifies settings remain writable. It does not call
a model, read user credentials, or modify the working checkout.

The bootstrap is verified on `x86_64-linux`. Other system outputs are
provided to match the existing cast flake but have not been runtime-tested.
