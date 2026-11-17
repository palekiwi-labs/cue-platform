{
  description = "Cue platform: pi, cue and the tools around them";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nvf.url = "github:NotAShelf/nvf";
    cue = {
      url = "github:palekiwi-labs/cue/cue-agent-prototype";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    cast = {
      url = "github:palekiwi-labs/cast/feat/cast-tui";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      nvf,
      cue,
      cast,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        platform = import ./nix/packages.nix {
          inherit
            pkgs
            nvf
            cue
            cast
            ;
        };
        # Host side: cast and its TUI. Kept out of the container bundle.
        station = import ./nix/station.nix { inherit pkgs; };
        host = {
          inherit (cast.packages.${system}) cast;
          cast-tui = import ./nix/cast-tui.nix { inherit pkgs; };
        };
      in
      {
        packages =
          platform
          // host
          // {
            inherit station;
            cue-github = import ./nix/cue-github.nix { inherit pkgs; };
            host = pkgs.symlinkJoin {
              name = "cue-platform-host";
              paths = builtins.attrValues host;
              meta.mainProgram = "cast";
            };
            # Everything above in one package, so consumers add a single
            # entry and pick up new tools without editing their flake.
            default = pkgs.buildEnv {
              name = "cue-platform";
              # The picker stays off PATH: tmux binds it by store path.
              paths = builtins.attrValues (removeAttrs platform [ "tmux-window-picker" ]) ++ [ station ];
            };
          };

        devShells.default = pkgs.mkShell {
          packages = [
            platform.pi
            pkgs.bun
            pkgs.nats-server
            pkgs.nodejs
            pkgs.nats-server
            pkgs.python3
            pkgs.tmux
          ];
        };
      }
    );
}
