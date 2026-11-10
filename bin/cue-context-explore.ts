#!/usr/bin/env bun
import { execFile } from "node:child_process"
import {
  ExploreError,
  exploreContext,
  parseDetail,
  type Exec,
} from "../src/pi/lib/context-explore"

const USAGE =
  "usage: cue-context-explore <context-address> [--detail identity|brief|working]"

const exec = ((cmd: string, args: string[], opts?: { cwd?: string }) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0
      resolve({ stdout, stderr, code, killed: false })
    })
  })) as Exec["exec"]

async function main(argv: string[]): Promise<number> {
  let address: string | undefined
  let detail: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "-h" || a === "--help") {
      console.log(USAGE)
      return 0
    }
    if (a === "--detail") detail = argv[++i]
    else if (a.startsWith("--detail=")) detail = a.slice("--detail=".length)
    else if (address === undefined) address = a
    else {
      console.error(USAGE)
      return 2
    }
  }
  if (!address) {
    console.error(USAGE)
    return 2
  }
  try {
    console.log(await exploreContext({ exec }, process.cwd(), address, parseDetail(detail)))
    return 0
  } catch (e) {
    if (!(e instanceof ExploreError)) throw e
    console.error(`cue-context-explore: ${e.message}`)
    return 1
  }
}

process.exit(await main(process.argv.slice(2)))
