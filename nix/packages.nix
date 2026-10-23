# Everything cue-platform ships through nix, for one system. The pi
# package itself (extensions, skills, prompts) is not here: it is
# installed with pi's own mechanism (see README).
{ pkgs, llm-agents, nvf }:
{
  inherit (llm-agents.packages.${pkgs.stdenv.hostPlatform.system}) pi;
  cue-review = import ./cue-review { inherit pkgs; };
  nvim = import ./nvim { inherit pkgs nvf; };
}
// import ./tmux { inherit pkgs; }
