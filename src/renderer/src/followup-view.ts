import type { Followup, HandoffOutcome, HandoffTrigger } from "../../shared/types";
import { S } from "./strings";

export function splitFollowups(list: Followup[]): { active: Followup[]; closed: Followup[] } {
  return {
    active: list.filter((f) => f.status === "open" || f.status === "snoozed"),
    closed: list.filter((f) => f.status === "done" || f.status === "ignored"),
  };
}

export function followupMeta(f: Followup): string {
  const parts = [S.followupKind[f.kind], S.followupTrigger[f.trigger]];
  if (f.dueDate) parts.push(f.dueDate);
  if (f.status === "snoozed" && f.snoozedUntil) parts.push(S.snoozedUntil(f.snoozedUntil));
  if (f.status === "done") parts.push(S.followupDone);
  if (f.status === "ignored") parts.push(S.followupIgnored);
  return parts.join(" · ");
}

export function outcomeMessage(o: HandoffOutcome): string {
  if (o.status === "stored") return o.degraded ? S.handoffDegraded : S.handoffStored;
  if (o.status === "skipped") return S.handoffSkipped[o.reason] ?? o.reason;
  return S.handoffFailed(o.message);
}

export function triggerLabel(t: HandoffTrigger): string {
  return S.handoffTrigger[t];
}
