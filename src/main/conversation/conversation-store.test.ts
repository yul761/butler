import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONV_LIST_MAX, type ConvMessage } from "../../shared/conversation";
import { ConvRepo } from "../db/conv-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { setLang } from "../i18n";
import { M } from "../strings";
import { memDb, tempDir } from "../test-utils";
import { CONV_TEXT_MAX } from "./conv-parse";
import { ConversationStore, RECENT_QA_QUESTION_CHARS, withRecentQa } from "./conversation-store";

afterEach(() => setLang("zh"));

/** 链 a → b → c（b 在 t=1000 换新，c 在 t=3000 换新）。 */
function env() {
  const db = memDb();
  const sessions = new SessionsRepo(db);
  const repo = new ConvRepo(db);
  sessions.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 0 });
  sessions.insertIfAbsent({ id: "b", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1000 });
  sessions.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 3000 });
  sessions.setReplacedBy("a", "b");
  sessions.setReplacedBy("b", "c");
  const appended: string[] = [];
  const store = new ConversationStore({ repo, sessions, onAppended: (r) => appended.push(r), now: () => 9999 });
  let key = 0;
  /** 在链根 a 下写一轮问答。 */
  const turn = (q: string, a: string, at: number, qa: "yes" | "no" | "pending" = "yes", sessionId = "a"): number => {
    const id = repo.openTurn({ rootSessionId: "a", sessionId, sourceKey: `k${++key}`, forkId: null, kind: "user", at, asked: true });
    repo.addMessage({ turnId: id, rootSessionId: "a", sessionId, role: "user", text: q, at, forkId: null, sourceKey: `m${++key}` });
    repo.addMessage({ turnId: id, rootSessionId: "a", sessionId, role: "assistant", text: a, at: at + 1, forkId: null, sourceKey: `m${++key}` });
    repo.touchTurn(id, { at: at + 1, endedAt: at + 1 });
    if (qa !== "pending") repo.setQa(id, qa, "rule");
    return id;
  };
  return { db, sessions, repo, store, appended, turn };
}

const fork = (forkId: number, role: "user" | "assistant", text: string, at: number, extra: Partial<Omit<ConvMessage, "id">> = {}): Omit<ConvMessage, "id"> => ({
  rootSessionId: "a", sessionId: "c", role, text, at, forkId, qa: false, turnId: 0, ...extra,
});

describe("ConversationStore: any id on the chain means the chain", () => {
  it("lists, searches and summarises the same for a, b and c; unknown ids are empty", () => {
    const e = env();
    e.turn("换新阈值是多少？", "150k。", 100);
    e.turn("CI 为什么挂了？", "lint 没过。", 2000, "yes", "b");
    expect(e.store.rootOf("c")).toBe("a");
    expect(e.store.rootOf("zzz")).toBe("zzz");
    const la = e.store.list("a", { limit: 50 });
    expect(e.store.list("b", { limit: 50 })).toEqual(la);
    expect(e.store.list("c", { limit: 50 })).toEqual(la);
    expect(la.messages).toHaveLength(4);
    expect(e.store.search("c", "lint")).toEqual(e.store.search("a", "lint"));
    expect(e.store.search("c", "lint")).toHaveLength(1);
    expect(e.store.recentQa("b", 6000)).toBe(e.store.recentQa("a", 6000));
    expect(e.store.list("zzz", { limit: 50 })).toEqual({ messages: [], refreshMarks: [], hasMore: false });
  });
});

describe("ConversationStore.list refresh marks", () => {
  it("puts each mark on the page whose time range holds it", () => {
    const e = env();
    // b 在 1000 换新（落在 500..503 那页和 2000 那页之间：归更早那页，它的上界是 2000），c 在 3000（晚于最后一条：归最新那页）。
    e.turn("早问", "早答", 500);
    e.turn("早问2", "早答2", 502);
    e.turn("晚问", "晚答", 2000);
    e.turn("晚问2", "晚答2", 2002);
    const latest = e.store.list("c", { limit: 2 });
    expect(latest.hasMore).toBe(true);
    expect(latest.messages.map((m) => m.at)).toEqual([2002, 2003]);
    expect(latest.refreshMarks).toEqual([{ at: 3000, sessionId: "c" }]);
    const mid = e.store.list("c", { limit: 2, before: latest.messages[0].id });
    expect(mid.messages.map((m) => m.at)).toEqual([2000, 2001]);
    expect(mid.refreshMarks).toEqual([]);
    const earliest = e.store.list("c", { limit: 4, before: mid.messages[0].id });
    expect(earliest.hasMore).toBe(false);
    expect(earliest.messages.map((m) => m.at)).toEqual([500, 501, 502, 503]);
    expect(earliest.refreshMarks).toEqual([{ at: 1000, sessionId: "b" }]);
  });

  it("includes a mark earlier than the first message on the earliest page", () => {
    const e = env();
    e.turn("问", "答", 5000);
    expect(e.store.list("a", { limit: 10 }).refreshMarks).toEqual([{ at: 1000, sessionId: "b" }, { at: 3000, sessionId: "c" }]);
  });

  it("returns every mark for an empty conversation, and none past the start", () => {
    const e = env();
    expect(e.store.list("a", { limit: 10 }).refreshMarks).toEqual([{ at: 1000, sessionId: "b" }, { at: 3000, sessionId: "c" }]);
    e.turn("问", "答", 5000);
    const first = e.store.list("a", { limit: 10 }).messages[0];
    expect(e.store.list("a", { limit: 10, before: first.id })).toEqual({ messages: [], refreshMarks: [], hasMore: false });
  });

  it("treats a before id it does not know, or one from another conversation, as no cursor (layer 4 carry-over R3)", () => {
    const e = env();
    e.turn("问1", "答1", 100);
    e.turn("问2", "答2", 200);
    const latest = e.store.list("c", { limit: 3 });
    expect(latest.messages).toHaveLength(3);
    expect(e.store.list("c", { limit: 3, before: 99_999 })).toEqual(latest);
    // 别的对话里的一条（时间比 a 的都早）：不能拿它的时间去截 a 的对话。
    const t = e.repo.openTurn({ rootSessionId: "z", sessionId: "z", sourceKey: "zk", forkId: null, kind: "user", at: 50, asked: true });
    const foreign = e.repo.addMessage({ turnId: t, rootSessionId: "z", sessionId: "z", role: "user", text: "别处", at: 50, forkId: null, sourceKey: "zm" });
    expect(foreign).not.toBeNull();
    expect(e.store.list("c", { limit: 3, before: foreign!.id })).toEqual(latest);
    // 空对话加不认识的 before：换新标记照样全给（跟不带 before 一样）。
    const empty = env();
    expect(empty.store.list("a", { limit: 10, before: 12_345 })).toEqual(empty.store.list("a", { limit: 10 }));
  });

  it("clamps the limit to 1..CONV_LIST_MAX", () => {
    const e = env();
    for (let i = 0; i < 110; i++) e.turn(`问${i}`, `答${i}`, 10 + i * 2);
    expect(e.store.list("a", { limit: 0 }).messages).toHaveLength(1);
    expect(e.store.list("a", { limit: 1000 }).messages).toHaveLength(CONV_LIST_MAX);
  });
});

describe("ConversationStore.recentQa", () => {
  it("takes only Q&A turns, oldest first", () => {
    const e = env();
    e.turn("第一问？", "第一答", 100);
    e.turn("改一下按钮", "改好了", 200, "no");
    e.turn("还在判？", "嗯", 300, "pending");
    e.turn("第二问？", "第二答", 400);
    const out = e.store.recentQa("a", 6000);
    expect(out.startsWith(`# ${M().convResume.title}\n\n${M().convResume.intro(2)}\n\n`)).toBe(true);
    expect(out).toContain(`## ${M().refreshTail.user}\n\n第一问？\n\n## ${M().refreshTail.assistant}\n\n第一答`);
    expect(out.indexOf("第一问？")).toBeLessThan(out.indexOf("第二问？"));
    expect(out).not.toContain("改好了");
    expect(out).not.toContain("还在判");
    expect(out.endsWith("第二答\n")).toBe(true);
  });

  it("keeps only the newest turns that fit", () => {
    const e = env();
    for (let i = 0; i < 10; i++) e.turn(`问题${i}${"问".repeat(20)}`, `回答${i}${"答".repeat(20)}`, 100 + i * 10);
    const out = e.store.recentQa("a", 300);
    expect([...out].length).toBeLessThanOrEqual(300);
    expect(out).toContain("回答9");
    expect(out).not.toContain("回答0");
  });

  it("cuts a single turn that is too long: whole question, tail of the answer", () => {
    const e = env();
    e.turn("这段代码做什么？", `开头${"答".repeat(10_000)}结尾`, 100);
    const out = e.store.recentQa("a", 2000);
    expect([...out].length).toBeLessThanOrEqual(2000);
    expect(out).toContain("这段代码做什么？");
    expect(out).toContain(M().refreshTail.cut);
    expect(out).toContain("结尾");
    expect(out).not.toContain("开头");
  });

  it("caps the question of a single long turn", () => {
    const e = env();
    e.turn(`${"问".repeat(RECENT_QA_QUESTION_CHARS)}多出来的`, "答".repeat(5000), 100);
    const out = e.store.recentQa("a", 2000);
    expect(out).toContain("问".repeat(RECENT_QA_QUESTION_CHARS));
    expect(out).not.toContain("多出来的");
    expect([...out].length).toBeLessThanOrEqual(2000);
  });

  it("is empty without Q&A or without room", () => {
    const e = env();
    expect(e.store.recentQa("a", 6000)).toBe("");
    e.turn("问？", "答", 100);
    expect(e.store.recentQa("a", 0)).toBe("");
  });

  it("writes the heading in English when the app is in English", () => {
    setLang("en");
    const e = env();
    e.turn("why?", "because", 100);
    expect(e.store.recentQa("a", 6000).startsWith("# Recent questions and answers")).toBe(true);
  });
});

describe("ConversationStore.append (fork messages, layer 5)", () => {
  it("opens a fork turn on a user message and hangs the reply on it", () => {
    const e = env();
    const q = e.store.append(fork(1, "user", "分叉问一下？", 100, { qa: true }));
    expect(q).toMatchObject({ forkId: 1, qa: false, rootSessionId: "a", sessionId: "c", role: "user", text: "分叉问一下？" });
    const a = e.store.append(fork(1, "assistant", "分叉的回答", 101));
    expect(a.turnId).toBe(q.turnId);
    expect(e.repo.turn(q.turnId)).toMatchObject({ kind: "fork", forkId: 1, qa: "no", qaBy: "fork" });
    const other = e.store.append(fork(2, "user", "另一个分叉", 102));
    expect(other.turnId).not.toBe(q.turnId);
  });

  it("refuses non-fork messages and writes nothing", () => {
    const e = env();
    expect(() => e.store.append(fork(1, "user", "x", 1, { forkId: null }))).toThrow();
    expect(e.db.prepare(`SELECT COUNT(*) AS n FROM conv_messages`).get()).toEqual({ n: 0 });
    expect(e.db.prepare(`SELECT COUNT(*) AS n FROM conv_turns`).get()).toEqual({ n: 0 });
    expect(e.appended).toEqual([]);
  });

  it("files under the chain root and tells the page about the root", () => {
    const e = env();
    const m = e.store.append(fork(1, "user", "x", 1, { rootSessionId: "b" }));
    expect(m.rootSessionId).toBe("a");
    expect(e.appended).toEqual(["a"]);
  });

  it("an assistant message with no fork turn yet opens one", () => {
    const e = env();
    const a = e.store.append(fork(3, "assistant", "先回答了", 1));
    expect(e.repo.turn(a.turnId)).toMatchObject({ kind: "fork", forkId: 3 });
  });

  it("never shows up in recentQa, even when the fork turn is marked yes", () => {
    const e = env();
    const q = e.store.append(fork(1, "user", "分叉问一下？", 100));
    e.store.append(fork(1, "assistant", "分叉的回答", 101));
    e.repo.setQa(q.turnId, "yes", "judge");
    expect(e.store.recentQa("a", 6000)).toBe("");
  });

  it("caps very long text", () => {
    const e = env();
    const m = e.store.append(fork(1, "assistant", "长".repeat(CONV_TEXT_MAX + 5000), 1));
    expect([...m.text].length).toBeLessThanOrEqual(CONV_TEXT_MAX + 40);
  });
});

describe("ConversationStore.byFork", () => {
  it("returns one fork's messages in time order", () => {
    const e = env();
    e.store.append(fork(1, "user", "1 问", 10));
    e.store.append(fork(2, "user", "2 问", 11));
    e.store.append(fork(1, "assistant", "1 答", 12));
    e.store.append(fork(2, "assistant", "2 答", 13));
    expect(e.store.byFork(1).map((m) => m.text)).toEqual(["1 问", "1 答"]);
    expect(e.store.byFork(99)).toEqual([]);
  });
});

describe("withRecentQa", () => {
  it("appends the Q&A to the tail", async () => {
    const dir = tempDir("shipherd-qa-");
    const tail = join(dir, "tail.md");
    writeFileSync(tail, "# tail\n");
    expect(await withRecentQa(join(dir, "out.md"), tail, "# qa\n")).toBe(tail);
    const text = readFileSync(tail, "utf8");
    expect(text.startsWith("# tail\n")).toBe(true);
    expect(text.endsWith("# qa\n")).toBe(true);
  });

  it("writes the Q&A alone when there is no tail", async () => {
    const out = join(tempDir("shipherd-qa-"), "sub", "out.md");
    expect(await withRecentQa(out, null, "# qa\n")).toBe(out);
    expect(readFileSync(out, "utf8")).toBe("# qa\n");
  });

  it("writes nothing when there is neither", async () => {
    const out = join(tempDir("shipherd-qa-"), "out.md");
    expect(await withRecentQa(out, null, "")).toBeNull();
    expect(existsSync(out)).toBe(false);
  });
});
