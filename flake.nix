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
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      llm-agents,
      nvf,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        platform = import ./nix/packages.nix { inherit pkgs llm-agents nvf; };
      in
      {
        packages = platform // {
          default = platform.pi;
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
