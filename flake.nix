{
  description = "Cue platform: pi, cue and the tools around them";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nvf.url = "github:NotAShelf/nvf";
    cue = {
      url = "github:palekiwi-labs/cue/cue-agent-prototype";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    cast = {
      url = "github:palekiwi-labs/cast/spike/herdr-service-pivot";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      llm-agents,
      nvf,
      cue,
      cast,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        platform = import ./nix/packages.nix { inherit pkgs llm-agents nvf cue cast; };
      in
      {
        packages = platform // {
          # Everything above in one package, so consumers add a single
          # entry and pick up new tools without editing their flake.
          default = pkgs.buildEnv {
            name = "cue-platform";
            # The picker stays off PATH: tmux binds it by store path.
            paths = builtins.attrValues (removeAttrs platform [ "tmux-window-picker" ]);
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [
            platform.pi
            pkgs.bun
            pkgs.nodejs
            pkgs.python3
            pkgs.tmux
          ];
        };
      }
    );
}
