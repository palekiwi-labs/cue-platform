{ pkgs }:
let
  src = ../github-service;
  packageJson = pkgs.lib.importJSON (src + "/package.json");
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "cue-github";
  version = packageJson.version;
  src = pkgs.lib.cleanSourceWith {
    inherit src;
    filter =
      path: type:
      !(builtins.elem (baseNameOf path) [
        "node_modules"
        "dist"
        "build-test"
      ])
      && pkgs.lib.cleanSourceFilter path type;
  };
  npmDeps = pkgs.importNpmLock { npmRoot = src; };
  npmRebuildFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [
    pkgs.nodejs
    pkgs.importNpmLock.npmConfigHook
    pkgs.makeWrapper
  ];
  nativeCheckInputs = [ pkgs.nats-server ];
  buildPhase = ''
    runHook preBuild
    npm run build
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run format:check
    npm run typecheck
    npm test
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    mkdir -p "$out/lib/cue-github" "$out/bin"
    cp -R package.json dist node_modules "$out/lib/cue-github"
    makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/cue-github" \
      --add-flags "$out/lib/cue-github/dist/main.js" \
      --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.gh ]}
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/cue-github" --help
    ${pkgs.nodejs}/bin/node --input-type=module -e '
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(":memory:");
      db.prepare("SELECT 1").get();
      db.close();
    '
    runHook postInstallCheck
  '';
  meta = {
    description = "Private GitHub repository snapshots over core NATS";
    mainProgram = "cue-github";
    license = pkgs.lib.licenses.mit;
  };
}
