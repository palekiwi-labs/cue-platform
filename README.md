# cue-platform

The cue-centered agent environment for cast containers.

## Bootstrap

The initial flake exports pi from `numtide/llm-agents.nix`, using the same
locked dependencies as the existing cast environment. It does not yet
bundle cue, extensions, skills, tmux, or Neovim. Pi continues to load the
existing writable user configuration and live extension checkouts.

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
extension source. The next migration step must preserve checkout-based
`/reload` and new-session testing, while keeping pi's runtime state writable.

## Validation

```sh
nix flake check
nix build .#pi --no-link
nix run . -- --version
```

The bootstrap is verified on `x86_64-linux`. Other system outputs are
provided to match the existing cast flake but have not been runtime-tested.
