{
  description = "Cue platform development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      llm-agents,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (system: {
      packages = {
        pi = llm-agents.packages.${system}.pi;
        default = llm-agents.packages.${system}.pi;
      };

      devShells = {
        default = nixpkgs.legacyPackages.${system}.mkShell {
          packages = [
            llm-agents.packages.${system}.pi
            nixpkgs.legacyPackages.${system}.python3
            nixpkgs.legacyPackages.${system}.tmux
          ];
        };
      };

      apps = {
        default = {
          type = "app";
          program = "${llm-agents.packages.${system}.pi}/bin/pi";
          meta.description = "Launch pi with the existing user configuration";
        };
      };
    });
}
