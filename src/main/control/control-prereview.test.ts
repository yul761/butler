import { describe, expect, it } from "vitest";
import { parseControlRequest } from "../../shared/control";
import type { PreReviewView } from "../../shared/prereview";
import type { Session } from "../../shared/types";
import { controlHandler, type ControlHandlerDeps } from "./control-handler";

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id, ticketKey: null, cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: false, replacedBy: null,
  dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, butler: false, lessonRunId: null, ...o,
});

const VIEW: PreReviewView = {
  id: 5, ticketKey: "BTL-1", sessionId: "s", target: { repoSlug: "o/r", branch: "b", headSha: "a".repeat(40) }, base: "main", prId: null, trigger: "evidence",
  status: "done", verdict: "violations", summary: null, detail: null, files: [{ path: "src/a.ts", added: 1, deleted: 0, binary: false }], lessonIds: [3], checks: null,
  violations: [{ lessonId: 3, checkKey: null, file: "src/a.ts", line: 4, severity: "must", what: "no error handling", fix: "wrap it", lessonText: "SECRET RULE TEXT" }],
  evidence: [{ id: 1, preReviewId: 5, prId: null, kind: "check", category: "test", name: "unit", command: "pnpm test", claimed: "pass", summary: "ok", verified: "rerun_pass", verifyDetail: "pnpm test", rerunOutput: null, createdAt: 1, verifiedAt: 2 }],
  missingEvidence: [{ category: "lint", state: "missing", detail: "" }], model: "m", deliveredAt: null, createdAt: 1, finishedAt: 3,
};

function setup(heads: Record<string, Session>, withPreReview = true) {
  const submitted: [string, unknown][] = [];
  const handle = controlHandler({
    tickets: { get: (key: string) => ({ key, archivedAt: key === "OLD-1" ? 5 : null }) } as unknown as ControlHandlerDeps["tickets"],
    ticketService: {} as never, sessionService: {} as never,
    sessions: { head: (id: string) => heads[id] ?? null } as unknown as ControlHandlerDeps["sessions"],
    kill: () => undefined, screenNeedsUser: () => false, submit: async () => "sent", notify: () => undefined,
    ...(withPreReview && {
      preReview: {
        submit: async (sid, raw) => (submitted.push([sid, raw]), sid === "dirty" ? { ok: false, message: "commit first" } : { ok: true, message: "queued aaaaaaa" }),
        latest: (sid) => (sid === "new" ? VIEW : null),
      },
    }),
  });
  return { handle, submitted };
}

describe("submit_evidence and pre_review_result (ws-g)", () => {
  it("parses both requests; evidence must be an object", () => {
    expect(parseControlRequest({ v: 1, ticketKey: "BTL-1", from: "s", op: "pre_review_result" })).toEqual({ v: 1, ticketKey: "BTL-1", from: "s", op: "pre_review_result" });
    expect(parseControlRequest({ v: 1, ticketKey: "BTL-1", from: "s", op: "submit_evidence", evidence: { checks: [] } })).toMatchObject({ op: "submit_evidence", evidence: { checks: [] } });
    expect(parseControlRequest({ v: 1, ticketKey: "BTL-1", from: "s", op: "submit_evidence", evidence: [] })).toBeNull();
    expect(parseControlRequest({ v: 1, ticketKey: "BTL-1", from: "s", op: "submit_evidence" })).toBeNull();
    expect(parseControlRequest({ v: 1, butler: true, from: "b", op: "pr_assessment", pr: "12" })).toEqual({ v: 1, butler: true, from: "b", op: "pr_assessment", pr: "12" });
    expect(parseControlRequest({ v: 1, butler: true, from: "b", op: "pr_assessment" })).toBeNull();
  });

  it("submits for the head of the calling session and passes the message back", async () => {
    const child = session("new", { ticketKey: "BTL-1" });
    const { handle, submitted } = setup({ old: child, new: child, dirty: session("dirty", { ticketKey: "BTL-1" }) });
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: "old", op: "submit_evidence", evidence: { checks: [] } })).toEqual({ v: 1, ok: true, value: { note: "queued aaaaaaa" } });
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: "dirty", op: "submit_evidence", evidence: {} })).toEqual({ v: 1, ok: false, error: "commit first" });
    expect(submitted).toEqual([["new", { checks: [] }], ["dirty", {}]]);
  });

  it("gives the latest result without the rule text or the file list", async () => {
    const child = session("new", { ticketKey: "BTL-1" });
    const { handle } = setup({ new: child, other: session("other", { ticketKey: "BTL-1" }) });
    const r = await handle({ v: 1, ticketKey: "BTL-1", from: "new", op: "pre_review_result" });
    expect(r.ok).toBe(true);
    const v = (r as { value: Record<string, unknown> }).value;
    expect(v).toMatchObject({
      id: 5, commit: "aaaaaaa", status: "done", verdict: "violations",
      violations: [{ where: "src/a.ts:4", severity: "must", what: "no error handling", fix: "wrap it" }],
      evidence: [{ kind: "check", category: "test", name: "unit", verified: "rerun_pass" }],
    });
    expect((v.missing as string[])[0]).toContain("lint");
    expect(JSON.stringify(v)).not.toContain("SECRET RULE TEXT");
    expect(v).not.toHaveProperty("files");
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: "other", op: "pre_review_result" })).toMatchObject({ ok: false });
  });

  it("refuses unknown callers, callers from another ticket, archived tickets, and when pre-review is not wired", async () => {
    const heads = { t: session("t", { ticketKey: "BTL-1" }) };
    const { handle, submitted } = setup(heads);
    const req = { op: "submit_evidence" as const, evidence: {} };
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: null, ...req })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: "ghost", ...req })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, ticketKey: "BTL-2", from: "t", ...req })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, ticketKey: "OLD-1", from: "t", ...req })).toMatchObject({ ok: false });
    expect(submitted).toEqual([]);
    expect(await setup(heads, false).handle({ v: 1, ticketKey: "BTL-1", from: "t", ...req })).toMatchObject({ ok: false });
  });
});
