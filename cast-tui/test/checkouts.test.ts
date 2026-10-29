import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutRoots, findCheckout } from "../src/checkouts.js";

const dirs = (...paths: string[]) => (path: string) => paths.includes(path);

test("checkout roots live under ~/code", () => {
  assert.deepEqual(checkoutRoots("/h"), [
    "/h/code/palekiwi",
    "/h/code/palekiwi-labs",
    "/h/code/spabreaks",
    "/h/code/vendor",
  ]);
});

test("finds a repo directly under its owner's root", () => {
  const roots = checkoutRoots("/h");
  const isDir = dirs("/h/code/palekiwi-labs/cast");
  assert.equal(
    findCheckout("palekiwi-labs/cast", roots, isDir),
    "/h/code/palekiwi-labs/cast",
  );
});

test("finds a repo as <root>/<owner>/<name>", () => {
  const roots = checkoutRoots("/h");
  const isDir = dirs("/h/code/vendor/NixOS/nixpkgs");
  assert.equal(
    findCheckout("NixOS/nixpkgs", roots, isDir),
    "/h/code/vendor/NixOS/nixpkgs",
  );
});

test("the first root holding the repo wins", () => {
  const isDir = dirs("/a/o/r", "/b/o/r");
  assert.equal(findCheckout("o/r", ["/a", "/b"], isDir), "/a/o/r");
});

test("no checkout for unknown or malformed repos", () => {
  const roots = checkoutRoots("/h");
  assert.equal(findCheckout("o/r", roots, dirs()), undefined);
  assert.equal(findCheckout("nope", roots, () => true), undefined);
  assert.equal(findCheckout("a/b/c", roots, () => true), undefined);
});
