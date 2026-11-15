{ pkgs }:
let
  source = builtins.path {
    path = ../src/supervisor;
    name = "cue-supervisor-source";
    filter = path: _: !(pkgs.lib.hasSuffix ".test.ts" path);
  };
in
pkgs.writeShellApplication {
  name = "cue-supervisor";
  runtimeInputs = [
    pkgs.bun
    pkgs.coreutils
    pkgs.git
    pkgs.systemd
  ];
  text = ''
    exec bun ${source}/cli.ts "$@"
  '';
}
