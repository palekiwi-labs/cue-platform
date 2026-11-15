{ pkgs }:
let
  source = builtins.path {
    path = ../src/supervisor;
    name = "cue-supervisor-source";
    filter = path: _: !(pkgs.lib.hasSuffix ".test.ts" path);
  };
  npm =
    name: version: hash:
    pkgs.fetchzip {
      url = "https://registry.npmjs.org/${name}/-/${builtins.baseNameOf name}-${version}.tgz";
      inherit hash;
    };
  dependencies = {
    "@nats-io/transport-node" =
      npm "@nats-io/transport-node" "3.4.0"
        "sha256-L8q5CPZdKWa+ImBS0uwqaQEDpFJ1C9eEpG3f7bkbF+Y=";
    "@nats-io/nats-core" =
      npm "@nats-io/nats-core" "3.4.0"
        "sha256-yUn/tfiOZq/22JoHZeZjKiiRM/jLGOdI2qKu09JlC/o=";
    "@nats-io/jetstream" =
      npm "@nats-io/jetstream" "3.4.0"
        "sha256-6PfHx8D+RJU8j9NRV6YwFQv4zb0BP2aIPqTLtHx0+eE=";
    "@nats-io/kv" = npm "@nats-io/kv" "3.4.0" "sha256-g0bW3nE656a0QwXD//y2UEAdlPg1I8oMii2KpKaj3LY=";
    "@nats-io/nkeys" =
      npm "@nats-io/nkeys" "2.0.3"
        "sha256-PGlY1hFAlA+8UiZkZAHLF6VsnXxn6D361OkeqyrV3pk=";
    "@nats-io/nuid" = npm "@nats-io/nuid" "3.0.0" "sha256-Zx8enKVumSJpP0jlzxtrlPQymisgNOh8rsQXaV7tjyA=";
    "tweetnacl" = npm "tweetnacl" "1.0.3" "sha256-6/GZEseS2C21pAvNOmJ5wBokji7Yd8bAuHnxPrYJAiU=";
  };
  bundle = pkgs.runCommand "cue-supervisor-bundle" { nativeBuildInputs = [ pkgs.bun ]; } ''
    mkdir -p node_modules/@nats-io $out
    ${pkgs.lib.concatStringsSep "\n" (
      pkgs.lib.mapAttrsToList (name: path: "cp -R ${path} node_modules/${name}") dependencies
    )}
    cp -R ${source} src
    bun build --target=bun src/cli.ts --outfile=$out/cli.js
  '';
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
    exec bun ${bundle}/cli.js "$@"
  '';
}
