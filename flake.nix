{
  description = "Cue platform development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, llm-agents, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system: {
        pi = llm-agents.packages.${system}.pi;
        default = llm-agents.packages.${system}.pi;
      });

      devShells = forAllSystems (system: {
        default = nixpkgs.legacyPackages.${system}.mkShell {
          packages = [ llm-agents.packages.${system}.pi ];
        };
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${llm-agents.packages.${system}.pi}/bin/pi";
          meta.description = "Launch pi with the existing user configuration";
        };
      });
    };
}
