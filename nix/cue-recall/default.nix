# Recall over the cue store: "have we already discussed this?".
#
# cue-recall runs the shallow pipeline (lexical candidates, context
# cards, one jev request) and needs TYPESAFE_API_KEY; cue-recall-lexical
# is the lexical stage alone. Both search only the caller's default cue
# query scope and call cue from PATH to resolve it. Stdlib Python.
{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "cue-recall";
  version = "0.1.0";
  src = pkgs.lib.fileset.toSource {
    root = ./.;
    fileset = pkgs.lib.fileset.unions [
      ./recall-lexical
      ./recall-shallow
    ];
  };
  nativeBuildInputs = [ pkgs.makeWrapper ];
  buildInputs = [ pkgs.python3 ];
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    # Kept side by side: recall-shallow imports recall-lexical from its
    # own directory.
    install -Dm755 recall-lexical recall-shallow -t $out/libexec/cue-recall
    patchShebangs $out/libexec/cue-recall
    # Never write bytecode next to the scripts (read-only store).
    makeWrapper $out/libexec/cue-recall/recall-shallow $out/bin/cue-recall \
      --set PYTHONDONTWRITEBYTECODE 1
    makeWrapper $out/libexec/cue-recall/recall-lexical $out/bin/cue-recall-lexical \
      --set PYTHONDONTWRITEBYTECODE 1
    runHook postInstall
  '';
  meta.mainProgram = "cue-recall";
}
