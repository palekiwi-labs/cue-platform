# The cast container's tmux: a tmux that always loads ./tmux.conf, and the
# fuzzy window picker that conf binds. The picker is referenced by store
# path, so the bindings do not depend on PATH.
{ pkgs }:
let
  tmux-window-picker = pkgs.writeShellApplication {
    name = "tmux-window-picker";
    runtimeInputs = [
      pkgs.fzf
      pkgs.gawk
      pkgs.tmux
    ];
    text = builtins.readFile ./window-picker.sh;
  };

  conf = pkgs.replaceVars ./tmux.conf {
    windowPicker = "${tmux-window-picker}/bin/tmux-window-picker";
  };

  tmux = pkgs.symlinkJoin {
    name = "tmux-cue-platform";
    paths = [ pkgs.tmux ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/tmux --add-flags "-f ${conf}"
    '';
  };
in
{
  inherit tmux tmux-window-picker;
}
