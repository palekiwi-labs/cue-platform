import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FINDING_STATUSES, isFindingStatus, operatorSubject, type FindingStatus, type FindingStatusChanged } from "../../src/nats/operator-events.js";
import { loadRun, runDir, type Finding, type FindingsRun } from "./findings.js";
import type { PopupContent } from "./popup.js";

export type PublishFindingStatus = (subject: string, event: FindingStatusChanged) => boolean;
export type ShowStatusPopup = (content: PopupContent, dismissable: boolean, keys?: Record<string, () => void>) => void;

export function saveFindingStatus(
  run: FindingsRun, findingId: string, status: FindingStatus, publish: PublishFindingStatus, store?: string,
): { run: FindingsRun; published: boolean } {
  if (!isFindingStatus(status)) throw new Error("invalid finding status");
  const file = join(runDir(run.address, store), run.source);
  const data = JSON.parse(readFileSync(file, "utf8"));
  const matches = (data.findings as unknown[]).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const finding = raw as Record<string, unknown>;
    return (finding.id ?? `finding-${index + 1}`) === findingId ? [finding] : [];
  });
  if (matches.length !== 1) throw new Error("finding is missing or has a duplicate id; refresh first");
  const finding = matches[0]!;
  const oldStatus = typeof finding.status === "string" ? finding.status : null;
  if (oldStatus === status && (status === "dismissed" || finding.dismiss_reason == null)) {
    return { run: loadRun(run.address, store), published: true };
  }
  finding.status = status;
  finding.dismiss_reason = status === "dismissed" ? (finding.dismiss_reason ?? "Dismissed by operator") : null;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
  const context = run.address.replace(/\/+$/, "").split("/").slice(0, 3).join("/");
  let published = false;
  try {
    published = publish(operatorSubject(context), {
      v: 1, ts: new Date().toISOString(), context,
      artifact_address: `${run.address.replace(/\/+$/, "")}/${run.source}`,
      finding_id: findingId, old_status: oldStatus, new_status: status, actor: "operator",
    });
  } catch {}
  return { run: loadRun(run.address, store), published };
}

export function chooseFindingStatus(
  run: FindingsRun, finding: Finding, show: ShowStatusPopup, publish: PublishFindingStatus,
): void {
  const keys = Object.fromEntries(FINDING_STATUSES.map((status, index) => [String.fromCharCode(97 + index), () => {
    show({ title: "confirm status", text: `${finding.id}: ${finding.status ?? "unset"} -> ${status}`,
      footer: "enter save  any other key cancel" }, true, { "\r": () => {
      try {
        const result = saveFindingStatus(run, finding.id, status, publish);
        Object.assign(run, result.run);
        if (!result.published) show({ title: "status saved", text: "NATS unavailable: change saved, event not published.", footer: "any key" }, true);
      } catch (e) {
        show({ title: "status save failed", text: e instanceof Error ? e.message : String(e), error: true, footer: "any key" }, true);
      }
    } });
  }]));
  show({ title: `finding status: ${finding.id}`, text: FINDING_STATUSES.map((status, index) =>
    `${String.fromCharCode(97 + index)}  ${status}${status === finding.status ? " (current)" : ""}`).join("\n"),
    footer: "letter select  any other key cancel" }, true, keys);
}
