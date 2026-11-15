import type { Exec } from "./exec.js";
import type { HostAction, Outcome } from "./picker/prs/browser.js";
import type { Pr } from "./picker/prs/model.js";
import { failed } from "./prs.js";

export const REVIEWER = "palekiwi";

async function gh(
  exec: Exec,
  cwd: string,
  args: string[],
  done: string,
): Promise<Outcome> {
  const r = await exec("gh", args, { cwd });
  if (r.code === 0) return { ok: true, text: done };
  return failed(`gh ${args.slice(0, 2).join(" ")}`, r);
}

/** LGTM approval and self-review request, offered on every PR. */
export function builtinActions(exec: Exec, cwd: string): HostAction[] {
  const ref = (pr: Pr) => [String(pr.number), "-R", pr.repo];
  return [
    {
      key: "alt+a",
      label: "lgtm",
      confirm: true,
      run: (pr) =>
        gh(
          exec,
          cwd,
          ["pr", "review", ...ref(pr), "--approve", "--body", "lgtm"],
          `approved ${pr.repo}#${pr.number}`,
        ),
    },
    {
      key: "alt+m",
      label: "request my review",
      run: (pr) =>
        gh(
          exec,
          cwd,
          ["pr", "edit", ...ref(pr), "--add-reviewer", REVIEWER],
          `requested ${REVIEWER}'s review on ${pr.repo}#${pr.number}`,
        ),
    },
  ];
}
