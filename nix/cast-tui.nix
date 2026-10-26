# cast-tui: the host terminal UI for cast. Bare `cast` execs it from PATH.
{ pkgs }:
let
  src = ../cast-tui;
  packageJson = pkgs.lib.importJSON (src + "/package.json");
in
pkgs.stdenv.mkDerivation {
  pname = "cast-tui";
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
  # importNpmLock reads package-lock.json at eval time, so there is
  # no npmDepsHash to maintain (pattern from pi's nix/package.nix).
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
  # pi-tui ships prebuilt native addons; the Linux one links libxcb.
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
    mkdir -p "$out/lib/cast-tui" "$out/bin"
    cp -R package.json bin dist node_modules "$out/lib/cast-tui"
    makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/cast-tui" \
      --add-flags "$out/lib/cast-tui/bin/cast-tui.js"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    # Load the host-platform pi-tui addons so a missing native
    # library fails the build instead of at runtime.
    ${pkgs.nodejs}/bin/node -e "
      const fs = require('node:fs'), path = require('node:path');
      const p = process.platform, dir = '$out/lib/cast-tui/node_modules/@earendil-works/pi-tui/native/' + p + '/prebuilds/' + p + '-' + process.arch;
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.node')) require(path.join(dir, f));
    "
    runHook postInstallCheck
  '';

  meta = with pkgs.lib; {
    description = "Terminal UI for cast";
    homepage = "https://github.com/palekiwi-labs/cue-platform";
    license = licenses.mit;
    mainProgram = "cast-tui";
  };
}
