import { describe, expect, it } from "vitest";
import { CONV_SEARCH_LIMIT } from "../../shared/conversation";
import { memDb } from "../test-utils";
import { ConvRepo } from "./conv-repo";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

function setup(opts?: { fts?: boolean }) {
  const db = memDb();
  const repo = new ConvRepo(db, opts);
  return { db, repo };
}

/** 一轮加一条 user 消息（at 递增），返回轮 id。 */
function say(repo: ConvRepo, root: string, key: string, text: string, at: number, role: "user" | "assistant" = "user", turnId?: number): number {
  const t = turnId ?? repo.openTurn({ rootSessionId: root, sessionId: root, sourceKey: `t:${key}`, forkId: null, kind: "user", at, asked: false });
  repo.addMessage({ turnId: t, rootSessionId: root, sessionId: root, role, text, at, forkId: null, sourceKey: key });
  return t;
}

describe("conversation migration", () => {
  it("creates the three tables", () => {
    const db = memDb();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["conv_turns", "conv_messages", "conv_cursors"]));
  });

  it("builds the FTS index in the test runtime (same as Electron)", () => {
    expect(setup().repo.searchMode).toBe("fts");
    expect(setup({ fts: false }).repo.searchMode).toBe("like");
  });

  it("is idempotent and rebuilds the index over rows written while FTS was off", () => {
    const db = memDb();
    const off = new ConvRepo(db, { fts: false });
    say(off, "r", "k1", "换新阈值是多少", 1);
    const on = new ConvRepo(db);
    expect(on.searchMode).toBe("fts");
    expect(on.search("r", "换新阈值").map((m) => m.text)).toEqual(["换新阈值是多少"]);
    expect(new ConvRepo(db).search("r", "换新阈值")).toHaveLength(1);
  });
});

describe("ConvRepo turns", () => {
  it("openTurn dedupes on (root, sourceKey); null keys always open a new turn", () => {
    const { repo } = setup();
    const t = { rootSessionId: "r", sessionId: "s", sourceKey: "u1", forkId: null, kind: "user" as const, at: 1, asked: true };
    const a = repo.openTurn(t);
    expect(repo.openTurn({ ...t, asked: false })).toBe(a);
    expect(repo.turn(a)?.asked).toBe(true);
    const n1 = repo.openTurn({ ...t, sourceKey: null });
    const n2 = repo.openTurn({ ...t, sourceKey: null });
    expect(new Set([a, n1, n2]).size).toBe(3);
  });

  it("touchTurn only raises flags, keeps the max lastAt and writes endedAt once", () => {
    const { repo } = setup();
    const id = repo.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: "u", forkId: null, kind: "user", at: 10, asked: false });
    repo.touchTurn(id, { at: 20, mutated: true, endedAt: 20 });
    repo.touchTurn(id, { at: 15, mutated: false, otherTools: true, endedAt: 30 });
    expect(repo.turn(id)).toMatchObject({ startedAt: 10, lastAt: 20, mutated: true, otherTools: true, endedAt: 20, qa: "pending", qaBy: null });
  });

  it("setQa reports whether it changed anything", () => {
    const { repo } = setup();
    const id = repo.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: "u", forkId: null, kind: "user", at: 1, asked: false });
    expect(repo.setQa(id, "yes", "rule")).toBe(true);
    expect(repo.setQa(id, "yes", "rule")).toBe(false);
    expect(repo.turn(id)).toMatchObject({ qa: "yes", qaBy: "rule" });
  });

  it("pendingEnded and endStale", () => {
    const { repo } = setup();
    const open = (key: string, kind: "user" | "silent", at: number) => repo.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: key, forkId: null, kind, at, asked: false });
    const a = open("a", "user", 1);
    const b = open("b", "user", 2);
    const c = open("c", "silent", 3);
    const d = open("d", "user", 4);
    repo.touchTurn(b, { at: 5, endedAt: 5 });
    repo.touchTurn(a, { at: 6, endedAt: 6 });
    repo.touchTurn(c, { at: 7, endedAt: 7 });
    expect(repo.pendingEnded(10).map((t) => t.id)).toEqual([b, a]);
    repo.touchTurn(d, { at: 100 });
    expect(repo.endStale(50)).toBe(0);
    // 终端还开着的 session 不结束（PR #60 review 5：长工具调用）。
    expect(repo.endStale(101, ["s"])).toBe(0);
    expect(repo.turn(d)?.endedAt).toBeNull();
    expect(repo.endStale(101, ["other"])).toBe(1);
    expect(repo.turn(d)?.endedAt).toBe(100);
    expect(repo.pendingEnded(1).map((t) => t.id)).toEqual([b]);
    // 接着上一批往后取（final review 1：判不了的轮不挡住后面的）。
    const first = repo.turn(b)!;
    expect(repo.pendingEnded(10, { endedAt: first.endedAt!, id: first.id }).map((t) => t.id)).toEqual([a, d]);
  });
});

describe("ConvRepo messages", () => {
  it("addMessage dedupes on sourceKey and carries the turn id", () => {
    const { repo, db } = setup();
    const t = repo.openTurn({ rootSessionId: "r", sessionId: "s", sourceKey: "u", forkId: null, kind: "user", at: 1, asked: false });
    const m = repo.addMessage({ turnId: t, rootSessionId: "r", sessionId: "s", role: "user", text: "hi", at: 1, forkId: null, sourceKey: "k" });
    expect(m).toMatchObject({ rootSessionId: "r", sessionId: "s", role: "user", text: "hi", at: 1, forkId: null, qa: false, turnId: t });
    expect(repo.addMessage({ turnId: t, rootSessionId: "r", sessionId: "s", role: "user", text: "hi", at: 1, forkId: null, sourceKey: "k" })).toBeNull();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM conv_messages`).get() as { n: number }).n).toBe(1);
    expect(repo.turnMessages(t).map((x) => x.id)).toEqual([m!.id]);
  });

  it("pages newest-first windows in ascending order, ties broken by id", () => {
    const { repo } = setup();
    const t = say(repo, "r", "k0", "m0", 0);
    for (let i = 1; i < 25; i++) say(repo, "r", `k${i}`, `m${i}`, i === 13 ? 12 : i, "assistant", t);
    const p1 = repo.page("r", { limit: 10 });
    expect(p1.hasMore).toBe(true);
    expect(p1.messages.map((m) => m.text)).toEqual(["m15", "m16", "m17", "m18", "m19", "m20", "m21", "m22", "m23", "m24"]);
    const p2 = repo.page("r", { limit: 10, before: p1.messages[0].id });
    expect(p2.messages.map((m) => m.text)).toEqual(["m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14"]);
    expect(p2.hasMore).toBe(true);
    const p3 = repo.page("r", { limit: 10, before: p2.messages[0].id });
    expect(p3.messages.map((m) => m.text)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(p3.hasMore).toBe(false);
    expect(repo.page("r", { limit: 10, before: 99_999 }).messages).toHaveLength(10);
    expect(repo.page("other", { limit: 10 })).toEqual({ messages: [], hasMore: false });
  });

  it("qaOnly keeps question turns and fork messages; qa reflects the turn", () => {
    const { repo } = setup();
    const yes = say(repo, "r", "a", "问？", 1);
    say(repo, "r", "a2", "答", 2, "assistant", yes);
    repo.setQa(yes, "yes", "rule");
    say(repo, "r", "b", "改按钮", 3);
    const fork = repo.openTurn({ rootSessionId: "r", sessionId: "r", sourceKey: null, forkId: 7, kind: "fork", at: 4, asked: false });
    repo.addMessage({ turnId: fork, rootSessionId: "r", sessionId: "r", role: "user", text: "分叉问", at: 4, forkId: 7, sourceKey: null });
    const all = repo.page("r", { limit: 10 });
    expect(all.messages.map((m) => [m.text, m.qa])).toEqual([["问？", true], ["答", true], ["改按钮", false], ["分叉问", false]]);
    expect(repo.page("r", { limit: 10, qaOnly: true }).messages.map((m) => m.text)).toEqual(["问？", "答", "分叉问"]);
  });
});

describe.each([{ fts: undefined }, { fts: false }])("ConvRepo.search (fts: $fts)", ({ fts }) => {
  it("matches long and short terms, ANDs them, treats wildcards literally", () => {
    const { repo } = setup({ fts });
    say(repo, "r", "1", "换新阈值是 150k", 1);
    say(repo, "r", "2", "把按钮改成蓝色", 2);
    say(repo, "r", "3", "100% done_now \"quoted\"", 3);
    say(repo, "q", "4", "另一个链的换新阈值", 4);
    expect(repo.search("r", "换新阈值").map((m) => m.text)).toEqual(["换新阈值是 150k"]);
    expect(repo.search("r", "蓝色").map((m) => m.text)).toEqual(["把按钮改成蓝色"]);
    expect(repo.search("r", "按钮 蓝色").map((m) => m.text)).toEqual(["把按钮改成蓝色"]);
    expect(repo.search("r", "按钮 阈值")).toEqual([]);
    expect(repo.search("r", "%")).toHaveLength(1);
    expect(repo.search("r", "_")).toHaveLength(1);
    expect(repo.search("r", "e_n")).toHaveLength(1);
    expect(repo.search("r", "\"quoted\"")).toHaveLength(1);
    expect(repo.search("r", "")).toEqual([]);
    expect(repo.search("r", "   ")).toEqual([]);
    expect(repo.search(null, "换新阈值").map((m) => m.text)).toEqual(["另一个链的换新阈值", "换新阈值是 150k"]);
  });

  it("returns newest first, capped", () => {
    const { repo } = setup({ fts });
    for (let i = 0; i < CONV_SEARCH_LIMIT + 5; i++) say(repo, "r", `k${i}`, `第 ${i} 条 note`, i);
    const hits = repo.search("r", "note");
    expect(hits).toHaveLength(CONV_SEARCH_LIMIT);
    expect(hits[0].text).toBe(`第 ${CONV_SEARCH_LIMIT + 4} 条 note`);
  });
});

describe("ConvRepo qa turns and forks", () => {
  it("qaTurns lists non-fork yes turns newest first", () => {
    const { repo } = setup();
    const a = say(repo, "r", "a", "a?", 1);
    const b = say(repo, "r", "b", "b?", 2);
    const c = say(repo, "r", "c", "c", 3);
    const f = repo.openTurn({ rootSessionId: "r", sessionId: "r", sourceKey: null, forkId: 1, kind: "fork", at: 4, asked: false });
    for (const id of [a, b, f]) repo.setQa(id, "yes", "rule");
    repo.setQa(c, "no", "rule");
    expect(repo.qaTurns("r", { limit: 10 }).map((t) => t.id)).toEqual([b, a]);
    expect(repo.qaTurns("r", { limit: 10, beforeStartedAt: 2 }).map((t) => t.id)).toEqual([a]);
    expect(repo.qaTurns("r", { limit: 1 }).map((t) => t.id)).toEqual([b]);
  });

  it("latestForkTurn and forkMessages", () => {
    const { repo } = setup();
    expect(repo.latestForkTurn("r", 1)).toBeNull();
    const t1 = repo.openTurn({ rootSessionId: "r", sessionId: "r", sourceKey: null, forkId: 1, kind: "fork", at: 1, asked: false });
    const t2 = repo.openTurn({ rootSessionId: "r", sessionId: "r", sourceKey: null, forkId: 1, kind: "fork", at: 3, asked: false });
    const o = repo.openTurn({ rootSessionId: "r", sessionId: "r", sourceKey: null, forkId: 2, kind: "fork", at: 5, asked: false });
    expect(repo.latestForkTurn("r", 1)?.id).toBe(t2);
    repo.addMessage({ turnId: t1, rootSessionId: "r", sessionId: "r", role: "user", text: "1a", at: 1, forkId: 1, sourceKey: null });
    repo.addMessage({ turnId: o, rootSessionId: "r", sessionId: "r", role: "user", text: "2a", at: 2, forkId: 2, sourceKey: null });
    repo.addMessage({ turnId: t2, rootSessionId: "r", sessionId: "r", role: "user", text: "1b", at: 3, forkId: 1, sourceKey: null });
    expect(repo.forkMessages(1).map((m) => m.text)).toEqual(["1a", "1b"]);
    expect(repo.forkMessages(9)).toEqual([]);
  });
});

describe("ConvRepo cursors and reroot", () => {
  it("saves and reads cursors", () => {
    const { repo } = setup();
    expect(repo.cursor("s")).toBeNull();
    const c = { sessionId: "s", rootSessionId: "r", file: "/f.jsonl", ino: "i42", offset: 100, openTurnId: 3, updatedAt: 9 };
    repo.saveCursor(c);
    expect(repo.cursor("s")).toEqual(c);
    repo.saveCursor({ ...c, offset: 200, openTurnId: null });
    expect(repo.cursor("s")).toEqual({ ...c, offset: 200, openTurnId: null });
  });

  it("stores an ino above 2^53 without losing it and reads rows an old build wrote", () => {
    const { db, repo } = setup();
    const c = { sessionId: "big", rootSessionId: "big", file: "/f", ino: "i18858823440414829", offset: 1, openTurnId: null, updatedAt: 1 };
    repo.saveCursor(c);
    expect(repo.cursor("big")).toEqual(c);
    // 旧版本把舍入过的 number 当 INTEGER 写进去：node:sqlite 默认读这一行会抛 RangeError，现在要读得出来。
    db.prepare(`INSERT INTO conv_cursors (session_id, root_session_id, file, ino, byte_offset, open_turn_id, updated_at) VALUES ('old', 'old', '/g', 18858823440414828, 5, NULL, 1)`).run();
    expect(repo.cursor("old")).toMatchObject({ ino: "18858823440414828", offset: 5 });
    repo.saveCursor({ ...c, sessionId: "old", rootSessionId: "old", ino: "i18858823440414830" });
    expect(repo.cursor("old")?.ino).toBe("i18858823440414830");
  });

  it("moves a session's turns, messages and cursor under a new root, dropping duplicates", () => {
    const { repo } = setup();
    // s1 的链根下已经有一份 resume 复制过来的那一轮（同 sourceKey）。
    const dupOld = repo.openTurn({ rootSessionId: "s1", sessionId: "s1", sourceKey: "u-dup", forkId: null, kind: "user", at: 1, asked: false });
    repo.addMessage({ turnId: dupOld, rootSessionId: "s1", sessionId: "s1", role: "user", text: "dup", at: 1, forkId: null, sourceKey: "m-dup" });
    // s2 自己当根读进来的。
    const dupNew = repo.openTurn({ rootSessionId: "s2", sessionId: "s2", sourceKey: "u-dup", forkId: null, kind: "user", at: 1, asked: false });
    repo.addMessage({ turnId: dupNew, rootSessionId: "s2", sessionId: "s2", role: "user", text: "dup", at: 1, forkId: null, sourceKey: "m-dup" });
    repo.addMessage({ turnId: dupNew, rootSessionId: "s2", sessionId: "s2", role: "assistant", text: "回复 zebra", at: 2, forkId: null, sourceKey: "m-reply" });
    const own = repo.openTurn({ rootSessionId: "s2", sessionId: "s2", sourceKey: "u-own", forkId: null, kind: "user", at: 3, asked: false });
    repo.addMessage({ turnId: own, rootSessionId: "s2", sessionId: "s2", role: "user", text: "新问题 zebra", at: 3, forkId: null, sourceKey: "m-own" });
    repo.saveCursor({ sessionId: "s2", rootSessionId: "s2", file: "/f", ino: "i1", offset: 10, openTurnId: own, updatedAt: 1 });

    repo.reroot("s2", "s1");

    expect(repo.page("s1", { limit: 50 }).messages.map((m) => [m.text, m.turnId])).toEqual([["dup", dupOld], ["回复 zebra", dupOld], ["新问题 zebra", own]]);
    expect(repo.page("s2", { limit: 50 }).messages).toEqual([]);
    expect(repo.turn(dupNew)).toBeNull();
    expect(repo.turn(own)?.rootSessionId).toBe("s1");
    expect(repo.cursor("s2")?.rootSessionId).toBe("s1");
    expect(repo.search("s1", "zebra")).toHaveLength(2);
    expect(repo.search("s2", "zebra")).toEqual([]);
  });
});
