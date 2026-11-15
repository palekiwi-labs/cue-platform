# station: the review station TUI. Bare `station` opens the demo packet.
{ pkgs }:
let
  src = ../station;
  packageJson = pkgs.lib.importJSON (src + "/package.json");
in
pkgs.stdenv.mkDerivation {
  pname = "station";
  version = packageJson.version;
  src = pkgs.lib.cleanSourceWith {
    inherit src;
    filter =
      path: type:
      let
        base = baseNameOf path;
      in
      !(builtins.elem base [
        "node_modules"
        "dist"
        "build-test"
      ])
      && (pkgs.lib.cleanSourceFilter path type);
  };
  npmDeps = pkgs.importNpmLock { npmRoot = src; };
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    pkgs.nodejs
    pkgs.importNpmLock.npmConfigHook
    pkgs.makeWrapper
  ]
  ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
    pkgs.autoPatchelfHook
  ];
  buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
    pkgs.stdenv.cc.cc.lib
    pkgs.libxcb
  ];
  dontStrip = true;

  buildPhase = ''
    runHook preBuild
    npm run build
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    find node_modules -type d -empty -delete
    mkdir -p "$out/lib/station" "$out/bin"
    cp -R package.json bin dist demo node_modules "$out/lib/station"
    makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/station" \
      --add-flags "$out/lib/station/bin/station.js"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    ${pkgs.nodejs}/bin/node -e "
      const fs = require('node:fs'), path = require('node:path');
      const p = process.platform, dir = '$out/lib/station/node_modules/@earendil-works/pi-tui/native/' + p + '/prebuilds/' + p + '-' + process.arch;
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.node')) require(path.join(dir, f));
    "
    runHook postInstallCheck
  '';

  meta = with pkgs.lib; {
    description = "Review station: human review surface for agent-made changes";
    homepage = "https://github.com/palekiwi-labs/cue-platform";
    license = licenses.mit;
    mainProgram = "station";
  };
}
