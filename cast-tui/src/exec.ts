import { execFile, spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts: ExecOptions,
) => Promise<ExecResult>;

const MAX_BUFFER = 64 * 1024 * 1024;

/** Runs a command to completion; never rejects, failures land in the result. */
export const exec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return resolve({ code: 127, stdout, stderr: `${cmd}: not found` });
        }
        resolve({
          code: typeof code === "number" ? code : 1,
          stdout,
          stderr: stderr || error.message,
        });
      },
    );
  });

const CLIPBOARD_COMMANDS: [string, string[]][] = [
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
  ["pbcopy", []],
];

function pipeTo(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

/** Copies text with the first clipboard tool that works. */
export async function copyToClipboard(text: string): Promise<void> {
  for (const [cmd, args] of CLIPBOARD_COMMANDS) {
    if (await pipeTo(cmd, args, text)) return;
  }
  throw new Error("no clipboard tool (wl-copy, xclip, xsel, pbcopy) worked");
}
