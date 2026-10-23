import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { contextFlag, dirFlag, storeFlag } from "./cue-args"

describe("dirFlag", () => {
  test("absent emits nothing", () => {
    expect(dirFlag(undefined, "/work")).toEqual([])
    expect(dirFlag("  ", "/work")).toEqual([])
  })

  test("absolute passes through", () => {
    expect(dirFlag("/elsewhere", "/work")).toEqual(["--dir", "/elsewhere"])
  })

  test("~ expands to home", () => {
    expect(dirFlag("~/proj", "/work")).toEqual(["--dir", `${homedir()}/proj`])
    expect(dirFlag("~", "/work")).toEqual(["--dir", homedir()])
  })

  test("relative resolves against cwd", () => {
    expect(dirFlag("../sibling", "/work/repo")).toEqual([
      "--dir",
      "/work/sibling",
    ])
  })
})

describe("contextFlag", () => {
  test("emits slug when present", () => {
    expect(contextFlag("auth")).toEqual(["--context", "auth"])
  })

  test("trims whitespace", () => {
    expect(contextFlag("  auth ")).toEqual(["--context", "auth"])
  })

  test("absent emits nothing", () => {
    expect(contextFlag(undefined)).toEqual([])
    expect(contextFlag("")).toEqual([])
    expect(contextFlag("   ")).toEqual([])
  })
})

describe("storeFlag", () => {
  test("absent emits nothing", () => {
    expect(storeFlag(undefined)).toEqual([])
  })

  test("~ expands to home", () => {
    expect(storeFlag("~/archive")).toEqual(["--store", `${homedir()}/archive`])
  })

  test("other values pass through trimmed", () => {
    expect(storeFlag(" /mnt/store ")).toEqual(["--store", "/mnt/store"])
  })
})
