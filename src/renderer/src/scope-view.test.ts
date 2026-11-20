import { describe, expect, it } from "vitest";
import type { Turn, TurnItem } from "../../shared/turn";
import { groupByFeature, prTag, progressLine, slowestLine, ticketRows, whoLabel } from "./scope-view";
import { STRINGS } from "./strings";

const S = STRINGS.zh;
const SE = STRINGS.en;

const item = (key: string, turn: Turn, pr: { repo: string; number: number } | null, o: Partial<TurnItem> = {}): TurnItem => ({
  ticketKey: key, pr: pr && { ...pr, title: "t", url: "u" }, epicId: 1, featureId: 10, turn, since: 5, others: 0, ...o,
});
const ext: Turn = { owner: "external", kind: "ci_running", names: ["CI"] };
const you: Turn = { owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: null };
const agent: Turn = { owner: "agent", kind: "working", sessionId: "s" };
const tk = (key: string, featureId: number | null = 10, effectiveStatus: "done" | "in_progress" = "in_progress") =>
  ({ key, title: `T ${key}`, featureId, effectiveStatus }) as never;

describe("ticketRows", () => {
  it("picks the most urgent PR turn and the item it came from", () => {
    const a = item("K-1", ext, { repo: "app", number: 52 });
    const b = item("K-1", you, { repo: "app", number: 51 });
    const s = item("K-1", agent, null);
    const [row] = ticketRows([tk("K-1")], [a, b, s]);
    expect(row.turn.owner).toBe("you");
    expect(row.others).toBe(1);
    expect(row.item).toBe(b);
    expect(row.prs.map((p) => p.number)).toEqual([51, 52]);
    expect(row.prs[0].tag).toBe("#51");
  });
  it("uses the most urgent session-level item, not the first", () => {
    const first = item("K-1", { owner: "external", kind: "awaiting_review", names: [] }, null);
    const urgent = item("K-1", agent, null);
    const [row] = ticketRows([tk("K-1")], [first, urgent]);
    expect(row.item).toBe(urgent);
  });
  it("tags PRs with the repo when there are several repos", () => {
    const [row] = ticketRows([tk("K-1")], [item("K-1", ext, { repo: "app", number: 52 }), item("K-1", ext, { repo: "api", number: 7 })]);
    expect(row.prs.map((p) => p.tag)).toEqual(["api#7", "app#52"]);
  });
  it("synthesizes done and idle rows", () => {
    const [d, i] = ticketRows([tk("K-2", 10, "done"), tk("K-3")], []);
    expect(d.turn).toEqual({ owner: "done", kind: "merged" });
    expect(i.turn).toEqual({ owner: "idle", kind: "not_started" });
    expect(d.item).toMatchObject({ ticketKey: "K-2", pr: null, since: 0, turn: d.turn });
    expect(i.since).toBe(0);
  });
});

describe("groupByFeature", () => {
  it("follows feature order, counts merged, keeps empty groups, ignores featureId null", () => {
    const rows = ticketRows([tk("A", 2, "done"), tk("B", 1), tk("C", null)], []);
    const g = groupByFeature(rows, [{ id: 1, name: "one" }, { id: 2, name: "two" }, { id: 3, name: "three" }]);
    expect(g.map((x) => [x.feature.id, x.rows.map((r) => r.key), x.merged])).toEqual([[1, ["B"], 0], [2, ["A"], 1], [3, [], 0]]);
  });
});

describe("lines and labels", () => {
  it("progressLine", () => {
    const r = { total: 15, merged: 9, youCount: 2 };
    expect(progressLine(r, S)).toBe("15 个里合了 9 个 · 2 件轮到你");
    expect(progressLine({ ...r, youCount: 0 }, S)).toBe("15 个里合了 9 个 · 没有事轮到你");
    expect(progressLine({ total: 0, merged: 0, youCount: 0 }, S)).toBe("还没有 ticket");
    expect(progressLine(r, SE)).toBe("9 of 15 merged · 2 waiting on you");
    expect(progressLine({ ...r, youCount: 0 }, SE)).toBe("9 of 15 merged · nothing waiting on you");
    expect(progressLine({ total: 0, merged: 0, youCount: 0 }, SE)).toBe("No tickets yet");
  });
  it("slowestLine", () => {
    expect(slowestLine("收尾 R/X", S)).toBe("最慢的是「收尾 R/X」。");
    expect(slowestLine(null, S)).toBe("没有明显落后的。");
  });
  it("whoLabel", () => {
    expect(whoLabel(you, S)).toBe("你");
    expect(whoLabel(agent, S)).toBe("agent");
    expect(whoLabel({ owner: "external", kind: "awaiting_review", names: ["甲", "乙"] }, S)).toBe("甲、乙");
    expect(whoLabel({ owner: "external", kind: "awaiting_review", names: ["a", "b"] }, SE)).toBe("a, b");
    expect(whoLabel({ owner: "external", kind: "awaiting_review", names: [] }, S)).toBe("外部");
    expect(whoLabel({ owner: "done", kind: "merged" }, S)).toBe("合了");
    expect(whoLabel({ owner: "idle", kind: "not_started" }, S)).toBe("没开始");
  });
  it("prTag", () => {
    expect(prTag({ repo: "app", number: 52 }, false)).toBe("#52");
    expect(prTag({ repo: "app", number: 52 }, true)).toBe("app#52");
  });
});
