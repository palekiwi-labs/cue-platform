# cue-context-explore: one cue context at a chosen detail. The same
# TypeScript module backs the pi tool; bun runs it from source, and the
# pi imports it uses are type-only, so no node_modules are needed.
{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "cue-context-explore";
  version = "0.1.0";
  src = pkgs.lib.fileset.toSource {
    root = ../..;
    fileset = pkgs.lib.fileset.unions [
      ../../bin/cue-context-explore.ts
      ../../src/pi/lib/context-explore.ts
      ../../src/pi/lib/context-recency.ts
    ];
  };
  nativeBuildInputs = [ pkgs.makeWrapper ];
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec/cue-context-explore
    cp -R bin src $out/libexec/cue-context-explore/
    makeWrapper ${pkgs.bun}/bin/bun $out/bin/cue-context-explore \
      --add-flags $out/libexec/cue-context-explore/bin/cue-context-explore.ts
    runHook postInstall
  '';
  meta.mainProgram = "cue-context-explore";
}
