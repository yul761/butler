import { describe, expect, it } from "vitest";
import type { ReportKind } from "../../shared/control";
import type { Session } from "../../shared/types";
import { controlHandler, type ControlHandlerDeps } from "./control-handler";

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id, ticketKey: null, cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: false, replacedBy: null,
  dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, epicId: null, model: null, butler: false, ...o,
});

/** 只用到 sessions.head、inbox 和 ticket / feature / epic 的归档时间：别的依赖给个空壳。archived 里的 ticket 号、feature-<id>、epic-<id> 算归档了。 */
function setup(heads: Record<string, Session>, withInbox = true, o: { archived?: string[]; noCoordinator?: boolean } = {}) {
  const asked: [string, unknown][] = [];
  const reported: [string, string, ReportKind][] = [];
  const archivedAt = (k: string) => (o.archived?.includes(k) ? 5 : null);
  const handle = controlHandler({
    tickets: { get: (key: string) => ({ key, archivedAt: archivedAt(key) }) } as unknown as ControlHandlerDeps["tickets"],
    features: { get: (id: number) => ({ id, archivedAt: archivedAt(`feature-${id}`) }) } as unknown as ControlHandlerDeps["features"],
    epics: { get: (id: number) => ({ id, archivedAt: archivedAt(`epic-${id}`) }) } as unknown as ControlHandlerDeps["epics"],
    ticketService: {} as never, sessionService: {} as never,
    sessions: { head: (id: string) => heads[id] ?? null } as unknown as ControlHandlerDeps["sessions"],
    kill: () => undefined, screenNeedsUser: () => false, submit: async () => "sent", notify: () => undefined,
    ...(withInbox && {
      inbox: {
        ask: (s, q) => (asked.push([s.id, q]), 7),
        report: (s, text, kind) => (reported.push([s.id, text, kind]), { id: 8, queued: !o.noCoordinator && kind !== "progress", noCoordinator: o.noCoordinator === true }),
      },
    }),
  });
  return { handle, asked, reported };
}

describe("controlHandler ask_user and report (BTL-190 2+3)", () => {
  it("records ask_user for the head of the calling session and tells it to end the turn", async () => {
    const child = session("new", { ticketKey: "BTL-1" });
    const { handle, asked } = setup({ old: child, new: child });
    const r = await handle({ v: 1, ticketKey: "BTL-1", from: "old", op: "ask_user", question: "Which?", options: ["A"] });
    expect(r).toEqual({ v: 1, ok: true, value: { id: 7, note: expect.stringContaining("结束这一轮") } });
    expect(asked).toEqual([["new", { question: "Which?", options: ["A"], context: undefined }]]);
  });

  it("stores a report and says whether it goes to the coordinator", async () => {
    const fc = session("fc", { featureId: 3 });
    const { handle, reported } = setup({ fc });
    expect(await handle({ v: 1, featureId: 3, from: "fc", op: "report", text: "done", kind: "done" })).toMatchObject({ ok: true, value: { id: 8, note: expect.stringContaining("总控") } });
    expect(await handle({ v: 1, featureId: 3, from: "fc", op: "report", text: "half", kind: "progress" })).toMatchObject({ ok: true, value: { note: "汇报已经存下。" } });
    expect(reported).toEqual([["fc", "done", "done"], ["fc", "half", "progress"]]);
  });

  it("refuses callers it cannot identify or that are outside the scope, and refuses without an inbox", async () => {
    const heads = { t: session("t", { ticketKey: "BTL-1" }), fc: session("fc", { featureId: 3 }), ep: session("ep", { epicId: 2 }) };
    const { handle, asked } = setup(heads);
    const ask = { op: "ask_user" as const, question: "q" };
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: null, ...ask })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: "ghost", ...ask })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, ticketKey: "BTL-2", from: "t", ...ask })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, featureId: 4, from: "fc", ...ask })).toMatchObject({ ok: false });
    // ticket 的 session 不能冒充 feature / epic 的。
    expect(await handle({ v: 1, featureId: 3, from: "t", ...ask })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, epicId: 2, from: "fc", ...ask })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, epicId: 2, from: "ep", ...ask })).toMatchObject({ ok: true });
    expect(asked.map(([id]) => id)).toEqual(["ep"]);
    expect(await setup(heads, false).handle({ v: 1, epicId: 2, from: "ep", ...ask })).toMatchObject({ ok: false });
  });

  it("says a report is only stored when no coordinator can be above the session", async () => {
    const { handle } = setup({ t: session("t", { ticketKey: "BTL-1" }) }, true, { noCoordinator: true });
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: "t", op: "report", text: "done", kind: "done" }))
      .toMatchObject({ ok: true, value: { id: 8, note: expect.stringContaining("没有管你的总控") } });
  });

  it("refuses ask_user and report for an archived ticket, feature or epic", async () => {
    const heads = { t: session("t", { ticketKey: "BTL-1" }), fc: session("fc", { featureId: 3 }), ep: session("ep", { epicId: 2 }) };
    const { handle, asked, reported } = setup(heads, true, { archived: ["BTL-1", "feature-3", "epic-2"] });
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: "t", op: "ask_user", question: "q" })).toEqual({ v: 1, ok: false, error: expect.stringContaining("归档") });
    expect(await handle({ v: 1, featureId: 3, from: "fc", op: "report", text: "r", kind: "done" })).toEqual({ v: 1, ok: false, error: expect.stringContaining("归档") });
    expect(await handle({ v: 1, epicId: 2, from: "ep", op: "ask_user", question: "q" })).toEqual({ v: 1, ok: false, error: expect.stringContaining("归档") });
    expect(asked).toEqual([]);
    expect(reported).toEqual([]);
  });
});
