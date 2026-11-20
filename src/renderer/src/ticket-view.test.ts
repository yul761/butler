import { describe, expect, it } from "vitest";
import type { PrStageCell, PrStagesView } from "../../shared/pr-stages";
import type { Turn } from "../../shared/turn";
import type { SessionView } from "../../shared/types";
import { STRINGS } from "./strings";
import { clipSaid, contextLine, conversationSessions, mainActions, prStageLine, prUrlOf, terminalLanding, ticketLanding } from "./ticket-view";

const S = STRINGS.zh;
const ids = (t: Turn, o = { hasPr: true, canFix: false }) => mainActions(t, o, S).map((a) => a.id);

describe("mainActions", () => {
  it("merge opens the PR; without a PR there is nothing", () => {
    const a = mainActions({ owner: "you", kind: "merge", risk: null }, { hasPr: true, canFix: false }, S);
    expect(a).toEqual([{ id: "open_pr", label: "打开 PR", primary: true }]);
    expect(ids({ owner: "you", kind: "merge", risk: null }, { hasPr: false, canFix: false })).toEqual([]);
  });
  it("answer goes to the terminal", () => {
    const a = mainActions({ owner: "you", kind: "answer", question: "q", options: [], askId: 1, sessionId: "s" }, { hasPr: false, canFix: false }, S);
    expect(a).toEqual([{ id: "answer", label: "去回答", primary: true, goTab: "terminal" }]);
  });
  it("stuck looks, and offers a fix only when it can", () => {
    const t: Turn = { owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: "s" };
    expect(ids(t)).toEqual(["look"]);
    expect(ids(t, { hasPr: false, canFix: true })).toEqual(["look", "fix"]);
    expect(mainActions(t, { hasPr: false, canFix: false }, S)[0].goTab).toBe("terminal");
  });
  it("unattended reads canSend from the turn", () => {
    const u = (canSend: boolean, why: "ci_failing" | "agent_stopped" = "ci_failing"): Turn => ({ owner: "you", kind: "unattended", why, canSend, sessionId: null });
    expect(mainActions(u(true), { hasPr: true, canFix: false }, S).map((a) => [a.id, a.primary, a.goTab])).toEqual([["send", true, undefined], ["pr_details", false, "pr"]]);
    expect(ids(u(false))).toEqual(["pr_details"]);
    expect(mainActions(u(false, "agent_stopped"), { hasPr: true, canFix: false }, S)).toEqual([{ id: "look", label: "去看看", primary: true, goTab: "terminal" }]);
  });
  it("nobody-to-click owners and butler notices give no buttons", () => {
    const none: Turn[] = [
      { owner: "agent", kind: "working", sessionId: "s" },
      { owner: "external", kind: "ci_running", names: [] },
      { owner: "done", kind: "merged" },
      { owner: "idle", kind: "not_started" },
      { owner: "you", kind: "butler", notice: { kind: "other" } as never },
    ];
    for (const t of none) expect(ids(t, { hasPr: true, canFix: true })).toEqual([]);
  });
});

describe("contextLine", () => {
  it("flags near refresh at 80% of the threshold", () => {
    expect(contextLine({ tokens: 148000, threshold: 150000 }, S)).toEqual({ text: "148k / 150k", nearRefresh: true });
    expect(contextLine({ tokens: 120000, threshold: 150000 }, S).nearRefresh).toBe(true);
    expect(contextLine({ tokens: 119000, threshold: 150000 }, S).nearRefresh).toBe(false);
    expect(contextLine({ tokens: 30000, threshold: 150000 }, S)).toEqual({ text: "30k / 150k", nearRefresh: false });
  });
  it("auto refresh off and unknown", () => {
    expect(contextLine({ tokens: 30000, threshold: 0 }, S)).toEqual({ text: "30k（自动换新已关）", nearRefresh: false });
    expect(contextLine(null, S)).toEqual({ text: "还不知道", nearRefresh: false });
  });
  it("english", () => {
    expect(contextLine({ tokens: 30000, threshold: 0 }, STRINGS.en).text).toBe("30k (auto refresh off)");
  });
});

const cell = (state: PrStageCell["state"], at: number | null = null): PrStageCell => ({ id: "dev", state, round: 1, at });
const row = (o: Partial<PrStagesView> & { done?: number; at?: number }): PrStagesView => {
  const stages = Array.from({ length: 6 }, (_, i) => cell(i < (o.done ?? 0) ? "done" : "todo", o.at ?? null));
  return {
    ticketKey: "BTL-1", featureId: null, repoId: 1, repoName: "r", prId: 1, slug: null, noPr: false,
    prNumber: 1, prUrl: "u", closed: false, stages, timeline: [], ...o,
  };
};

describe("prStageLine", () => {
  it("no rows, null, or only no-PR rows", () => {
    expect(prStageLine({ rows: [] }, S)).toBe("还没开 PR");
    expect(prStageLine(null, S)).toBe("还没开 PR");
    expect(prStageLine({ rows: [row({ noPr: true, prNumber: null, prId: null })] }, S)).toBe("还没开 PR");
  });
  it("counts done stages of the newest row", () => {
    expect(prStageLine({ rows: [row({ done: 5 })] }, S)).toBe("6 个阶段走完 5 个");
  });
  it("mentions the other open PRs and picks the newest by activity", () => {
    const line = prStageLine({ rows: [row({ prNumber: 1, done: 2, at: 1 }), row({ prNumber: 2, done: 4, at: 9 })] }, S);
    expect(line).toBe("6 个阶段走完 4 个 · 另有 1 个 PR");
  });
  it("all closed marks the newest as closed", () => {
    const line = prStageLine({ rows: [row({ closed: true, done: 1, at: 1 }), row({ closed: true, done: 3, at: 5 })] }, S);
    expect(line).toBe("6 个阶段走完 3 个（已关闭）");
  });
  it("a closed old PR does not hide the open one", () => {
    expect(prStageLine({ rows: [row({ closed: true, done: 6, at: 9 }), row({ done: 2, at: 1 })] }, S)).toBe("6 个阶段走完 2 个");
  });
});

const sess = (id: string, o: Partial<SessionView> = {}): SessionView =>
  ({ id, firstPrompt: `prompt ${id}`, fixesSession: null, spawnedBy: null, ...o }) as SessionView;

describe("conversationSessions", () => {
  it("labels fix sessions with a prefix", () => {
    expect(conversationSessions([sess("a"), sess("b", { fixesSession: "a" })], S)).toEqual([
      { id: "a", label: "prompt a" },
      { id: "b", label: "修复 · prompt b" },
    ]);
  });
});

describe("clipSaid", () => {
  it("clips long text to 280 chars plus an ellipsis", () => {
    const c = clipSaid("a".repeat(300));
    expect(c).toHaveLength(281);
    expect(c.endsWith("…")).toBe(true);
  });
  it("keeps short text", () => expect(clipSaid("hi")).toBe("hi"));
  it("counts characters, not UTF-16 units", () => {
    const c = clipSaid("😀".repeat(10), 4);
    expect(Array.from(c)).toEqual([..."😀😀😀😀", "…"]);
  });
});

describe("terminalLanding", () => {
  const answer: Turn = { owner: "you", kind: "answer", question: "q", options: [], askId: 1, sessionId: "s1" };
  const running = [sess("s1", { termId: "t1" }), sess("s2")];
  it("switches to the turn's terminal when it is already open", () => {
    expect(terminalLanding(answer, running, ["t0", "t1"])).toEqual({ activate: "t1" });
  });
  it("opens the turn's session when its terminal is not open", () => {
    expect(terminalLanding(answer, [sess("s1", { termId: null })], [])).toEqual({ open: "s1" });
    expect(terminalLanding(answer, running, ["t0"])).toEqual({ open: "s1" });
    expect(terminalLanding({ ...answer, sessionId: "gone" }, running, ["t1"])).toEqual({ open: "gone" });
  });
  it("stuck and stopped-agent turns carry their session too", () => {
    expect(terminalLanding({ owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: "s2" }, running, [])).toEqual({ open: "s2" });
    expect(terminalLanding({ owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s1" }, running, ["t1"])).toEqual({ activate: "t1" });
  });
  it("does nothing without a session", () => {
    expect(terminalLanding({ owner: "you", kind: "stuck", source: "ticket_blocked", detail: null, sessionId: null }, running, [])).toBeNull();
    expect(terminalLanding({ owner: "you", kind: "merge", risk: null }, running, ["t1"])).toBeNull();
  });
});

describe("ticketLanding", () => {
  const sessions = [sess("s1", { termId: "t1" }), sess("s2")];
  it("lands by the card's own turn: a PR waiting to be merged stays on the overview, even if the ticket's session is stuck", () => {
    expect(ticketLanding({ owner: "you", kind: "merge", risk: null }, sessions, ["t1"])).toEqual({ tab: "overview", terminal: null });
  });
  it("a failing-CI card lands on PR details; a stuck card on the terminal of its own session", () => {
    expect(ticketLanding({ owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: "s1" }, sessions, ["t1"])).toEqual({ tab: "pr", terminal: null });
    expect(ticketLanding({ owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: "s1" }, sessions, ["t1"])).toEqual({ tab: "terminal", terminal: { activate: "t1" } });
    expect(ticketLanding({ owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: "s2" }, sessions, ["t1"])).toEqual({ tab: "terminal", terminal: { open: "s2" } });
  });
});

describe("prUrlOf", () => {
  const pr = { repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" };
  const row = (o: { prNumber: number | null; prUrl: string | null; slug?: string | null }) => ({ slug: null, ...o }) as never;
  it("uses the turn's url until the stages arrive; no PR, no url", () => {
    expect(prUrlOf(pr, null)).toBe(pr.url);
    expect(prUrlOf(null, { rows: [] })).toBeNull();
  });
  it("one row with that number is it; none means no button", () => {
    expect(prUrlOf(pr, { rows: [row({ prNumber: 7, prUrl: "https://github.com/acme/api/pull/7?x" })] })).toBe("https://github.com/acme/api/pull/7?x");
    expect(prUrlOf(pr, { rows: [row({ prNumber: 8, prUrl: "u8" })] })).toBeNull();
  });
  it("same number in two repos: the one whose url or slug names this repo", () => {
    const web = row({ prNumber: 7, prUrl: "https://github.com/acme/web/pull/7" });
    const api = row({ prNumber: 7, prUrl: "https://github.com/Acme/API/pull/7" });
    expect(prUrlOf(pr, { rows: [web, api] })).toBe("https://github.com/Acme/API/pull/7");
    expect(prUrlOf(pr, { rows: [web, row({ prNumber: 7, prUrl: "https://ghe.example/x", slug: "acme/api" })] })).toBe("https://ghe.example/x");
    expect(prUrlOf(pr, { rows: [web, row({ prNumber: 7, prUrl: "https://github.com/acme/other/pull/7" })] })).toBeNull();
  });
});
