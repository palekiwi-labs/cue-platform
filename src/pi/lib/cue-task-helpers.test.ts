import { describe, expect, test } from "bun:test"
import { taskFrontmatter } from "./cue-task-helpers"

describe("taskFrontmatter", () => {
  test("defaults status to open and priority to normal", () => {
    expect(taskFrontmatter({ title: "T" })).toEqual({
      title: "T",
      status: "open",
      priority: "normal",
      refs: [],
    })
  })

  test("keeps explicit status and priority", () => {
    expect(
      taskFrontmatter({ title: "T", status: "in-progress", priority: "high" }),
    ).toEqual({
      title: "T",
      status: "in-progress",
      priority: "high",
      refs: [],
    })
  })

  test("adds parent only when given", () => {
    expect(taskFrontmatter({ title: "T", parent: "scope/ctx" })).toEqual({
      title: "T",
      status: "open",
      priority: "normal",
      refs: [],
      parent: "scope/ctx",
    })
  })

  test("refs default to empty array (emits no flags downstream)", () => {
    const fm = taskFrontmatter({ title: "T" })
    expect(fm.refs).toEqual([])
  })
})
