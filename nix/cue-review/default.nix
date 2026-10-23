# Multi-agent code review driving cue-agent (nushell prototype). See
# README.md for the run.json provenance format.
#
# Calls git, gh, tmux, cue and cue-agent from PATH; the cast devshell
# provides them.
{ pkgs }:
let
  cue-review-nu = pkgs.writers.writeNuBin "cue-review-nu" ./cue-review.nu;
in
pkgs.writeShellApplication {
  name = "cue-review";
  runtimeInputs = [ cue-review-nu ];
  text = builtins.readFile ./wrapper.sh;
}
