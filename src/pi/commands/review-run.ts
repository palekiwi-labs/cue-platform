import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { composeMessage, sendPrompt } from "./common"

/**
 * Workflow prompt for the automated multi-agent code diff review.
 *
 * Port of `~/.config/opencode/prompts/commands/review/run.md`, adapted for
 * pi: subagent dispatch goes through this extension's `delegate` tool
 * (agents come from the `cue-agent` roster listed in its description)
 * instead of opencode's `task` tool and named @diff-reviewer agents;
 * reviewers are one `reviewer` persona run on different model aliases.
 * The workflow shape (save-branch-diff -> parallel reviewers -> verify ->
 * canonical review-findings.json) is unchanged.
 */
export const REVIEW_RUN_PROMPT = `# Automated Code Diff Review Workflow

## Purpose

Execute an end-to-end multi-agent code review on the active branch diff:
1. Capture branch diff
2. Run two diff-reviewer subagents in parallel (with proof-of-work and adversarial framing)
3. Verify unverified claims against source code using a dedicated verifier
4. Save structured \`review-findings.json\` review artifact (serving as the actionable backlog / todo)

---

## Configuration & Agent Selection

### Defaults
- **Default Reviewers**: two tasks on the \`reviewer\` agent, each with a \`model\` alias from its allowlist (see the \`delegate\` tool description). Pick its default model (marked \`*\`) plus the next allowed alias whose provider differs, so the two reviews come from distinct providers.
- **Default Verifier**: the \`consultant\` agent on its default model

### Argument Resolution
Inspect the arguments block in the user message. If non-empty, parse any agent overrides:
- Reviewer models (e.g. "review with opus and glm", "--reviewers sol,flash"): one \`reviewer\` task per named alias. Two tasks on the same alias are allowed if explicitly asked.
- Verifier (e.g. "--verifier sol", "verify with glm"): a model alias for the \`consultant\` agent.
- Otherwise, use the defaults above.
- If a named alias is not in the relevant agent's allowlist, say so and fall back to the defaults. Never substitute silently.

---

## Workflow

### 1. Save Branch Diff
Execute the \`save-branch-diff\` tool, passing the active cue context slug as \`context\`.
- If the tool reports \`no_changes\`, inform the operator that there are no diff changes to review and stop.
- Note the saved \`DIFF_PATH\` (ensure full path is resolved) and the \`COMMIT\` (the reviewed commit hash reported by the tool's result). All worktrees in this run are pinned to \`COMMIT\` so reviewers and verifier see the identical tree even if the operator keeps committing during the run.
- Derive \`RUN_ID\` from \`DIFF_PATH\`: the name of its immediate parent directory, of the
  form \`<created_at>-<commit_hash>\` (e.g. \`1791255981686997923-13cfd7114e\`). Every
  artifact this run writes goes under \`review/<RUN_ID>/\`, so reruns never collide
  with earlier runs (cue-review never overwrites existing files).

### 2. Dispatch Parallel Reviewers
Dispatch the review in parallel to the two selected reviewer agents using the \`delegate\` tool with a single call (two tasks in one batch, each with \`worktree: { base: COMMIT }\` so the reviewers read a pinned checkout of the reviewed commit instead of the live tree the operator may be editing).

Pass the following prompt to each reviewer (replacing \`DIFF_PATH\` with the actual file path, \`RUN_ID\` with the run id derived in step 1, \`REVIEWER_SLUG\` with the task's model alias (e.g. \`opus\`), and \`CONTEXT_SLUG\` with the active cue context):

\`\`\`
Review the git diff changes saved at: DIFF_PATH
Cue context: CONTEXT_SLUG

Adhere strictly to your system prompt:
1. Anchor your review strictly to the diff hunks.
2. Formulate 1-3 falsifiable questions targeting concrete failure modes before exploring.
3. Strict read-only analysis: DO NOT run tests, builds, or package commands (no cargo test, npm test, etc.).
4. Use grep, glob, and ranged read (offset + limit) for context.
5. Sweep the 5-category taxonomy checklist (Correctness, Efficiency, Maintainability, Security, Testing & Observability).
6. Save your findings JSON with proof_of_work using cue-review (filename: "RUN_ID/reviewer-REVIEWER_SLUG.json", context: "CONTEXT_SLUG"). Do not add suffixes or rename on collision: the run directory is unique to this run.
7. Report back the saved review artifact path and summary count of findings.
\`\`\`

### 3. Parse and Aggregate Findings
When both reviewers return:
1. Use the \`read\` tool to read the JSON findings from the review artifact paths reported by each reviewer.
2. Confirm both reported paths live under \`review/<RUN_ID>/\`; a reviewer reporting any other name (e.g. a suffixed \`reviewer-opus-2.json\`). If both reviewers share an alias, give the second \`REVIEWER_SLUG\` a \`-2\` suffix in its prompt up front deviated from the layout.
3. Verify the review reasoning: ensure \`proof_of_work\` (falsifiable questions and categories swept) is populated. Reviewers no longer self-report models or files examined; attribute sources by artifact path and the reviewer task assignment, not guessed runtime model IDs.
4. Check for reviewer divergence: if there is a severe disparity (e.g. 0 findings vs >3 findings on a substantial diff), note the disparity.
5. Deduplicate or cluster findings across reviewers that identify the same defect in the same code location.
6. Collate candidate findings that require verification.

### 4. Focused Verification Pass
For candidate findings:
- Invoke the selected verifier agent via the \`delegate\` tool (with \`worktree: { base: COMMIT }\`, the same commit the reviewers were pinned to) to verify the findings and any \`unverified\` claims against the source code.
- Provide the verifier with:
  - Finding title, severity, category
  - File path, line range, snippet
  - The exact \`unverified\` claims to check
- Instruct the verifier to inspect the actual source code with \`read\` (ranged) and determine:
  - \`verified\`: The defect is confirmed and verified against callers/state.
  - \`refuted\`: The defect is disproven (e.g. guard exists, contract guarantees validity).
  - \`unconfirmable\`: Cannot be determined with certainty (e.g. depends on unpinned external behavior or unrecorded intent).
- Filter out \`refuted\` findings from the actionable output.

### 5. Save Canonical Findings JSON
Save the final verified findings as a single structured JSON review artifact in the active cue context using \`cue-review\` with \`filename: "<RUN_ID>/review-findings.json"\` and \`context: "<active-context-slug>"\`.

The canonical \`review-findings.json\` artifact format:
\`\`\`json
{
  "metadata": {
    "run_id": "<RUN_ID>",
    "commit_hash": "<commit-hash-of-the-reviewed-diff>",
    "timestamp": "YYYY-MM-DD",
    "branch": "<branch-name>",
    "base_branch": "<base-branch>",
    "reviewed_diff": "<diff-path>",
    "reviewers": ["reviewer@<alias>", "..."],
    "verifier": "consultant@<alias>"
  },
  "summary": {
    "total_candidates": 7,
    "verified": 6,
    "refuted": 0,
    "unconfirmable": 1,
    "by_severity": {
      "critical": 0,
      "high": 0,
      "medium": 3,
      "low": 4
    }
  },
  "findings": [
    {
      "id": "finding-1",
      "models": ["<reviewer-model-alias>"],
      "title": "Short descriptive summary",
      "category": "Correctness | Efficiency | Maintainability | Security | Testing & Observability",
      "severity": "critical | high | medium | low",
      "confidence": "high | medium | low",
      "status": "verified",
      "file": "path/to/source/file.ext",
      "line_start": 42,
      "line_end": 48,
      "snippet": "exact code snippet",
      "message": "Detailed explanation of the issue.",
      "suggested_fix": "Ready-to-apply code snippet or patch",
      "verification": {
        "verdict": "verified",
        "verifier": "consultant@<alias>",
        "reasoning": "Explanation of verification findings against callers and state."
      },
      "dismiss_reason": null
    }
  ]
}
\`\`\`

*Note on Lifecycle & Remediation*: the **latest run's** \`review-findings.json\` (the \`review/<RUN_ID>/\` directory with the highest \`created_at\` prefix) serves directly as the actionable backlog / todo list. As findings are addressed or triaged, update their \`status\` in-place in that file (\`"applied"\`, or \`"dismissed"\` with \`dismiss_reason\`). A new run never edits earlier runs' artifacts — it supersedes them. Do not create separate markdown reports or duplicate todo files.

### 6. Present Summary to Operator
Present a concise summary to the operator highlighting:
- Total candidates reviewed, verified, refuted, and unconfirmable
- Actionable findings categorized by severity with exact \`file:line_start-line_end\` locations
- Path to the saved \`review-findings.json\` artifact`

/**
 * Register `/review:run [args]`: kick off the automated multi-agent
 * branch-diff review workflow. pi-only port of the opencode prompt
 * `commands/review/run.md`; subagent dispatch is adapted to the
 * `delegate` tool (see REVIEW_RUN_PROMPT).
 */
export function registerReviewRunCommand(pi: ExtensionAPI): void {
  pi.registerCommand("review:run", {
    description:
      "Run an automated multi-agent review of the active branch diff",
    handler: async (args, ctx) => {
      sendPrompt(
        pi,
        ctx,
        composeMessage([
          args ? `<arguments>\n${args}\n</arguments>` : "",
          `PWD: ${ctx.cwd}`,
          REVIEW_RUN_PROMPT,
        ]),
      )
    },
  })
}
