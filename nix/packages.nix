# Everything cue-platform ships through nix, for one system. The pi
# package itself (extensions, skills, prompts) is not here: it is
# installed with pi's own mechanism (see README).
{
  pkgs,
  llm-agents,
  nvf,
  cue,
  cast,
}:
let
  system = pkgs.stdenv.hostPlatform.system;
in
{
  inherit (llm-agents.packages.${system}) pi;
  # gh is called from PATH by cue-review. jq has no shipped caller since
  # the cue-log-compact skill was retired; kept for agent shells.
  inherit (pkgs) gh jq;
  cue-review = import ./cue-review { inherit pkgs; };
  inherit (cue.packages.${system}) cue cue-agent;
  inherit (cast.packages.${system}) cast-mcp-client;
  nvim = import ./nvim { inherit pkgs nvf; };
}
// import ./tmux { inherit pkgs; }
