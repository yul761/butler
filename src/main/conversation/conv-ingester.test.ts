import { appendFileSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvRepo } from "../db/conv-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { M } from "../strings";
import { memDb, tempDir } from "../test-utils";
import { CONV_TEXT_MAX } from "./conv-parse";
import {
  CONV_BACKFILL_MS, CONV_JUDGE_MAX_AGE_MS, CONV_PAUSE_RETRY_MS, CONV_STALE_TURN_MS, CONV_SWEEP_MS, CONV_TICK_MS, ConvIngester, type ConvIngesterDeps,
} from "./conv-ingester";
import type { ConvQaVerdict } from "./conv-qa";

const FIXTURE = join(__dirname, "__fixtures__", "conv.jsonl");
// 录于改名前（BTL-260），里面的 butler-handoff 代码块是旧名字，见 conv-parse.test.ts。
const REFRESH_TAIL = join(__dirname, "..", "sessions", "__fixtures__", "refresh-tail.jsonl");

const ts = (n: number): string => new Date(Date.UTC(2026, 10, 19, 11, 0, 0) + n * 1000).toISOString();
const user = (uuid: string, parent: string | null, content: unknown, n: number): string =>
  JSON.stringify({ type: "user", uuid, parentUuid: parent, timestamp: ts(n), message: { role: "user", content } });
const reply = (uuid: string, parent: string | null, text: string, n: number, stop = true): string =>
  JSON.stringify({ type: "assistant", uuid, parentUuid: parent, timestamp: ts(n), message: { role: "assistant", stop_reason: stop ? "end_turn" : "tool_use", content: [{ type: "text", text }] } });
const tool = (uuid: string, parent: string | null, name: string, input: unknown, n: number): string =>
  JSON.stringify({ type: "assistant", uuid, parentUuid: parent, timestamp: ts(n), message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: `t-${uuid}`, name, input }] } });
const jsonl = (...lines: string[]): string => lines.map((l) => `${l}\n`).join("");

function env(extra: Partial<ConvIngesterDeps> = {}) {
  const db = memDb();
  const sessions = new SessionsRepo(db);
  const repo = new ConvRepo(db);
  const dir = tempDir("shipherd-conv-");
  const files = new Map<string, string>();
  const file = (id: string, content?: string): string => {
    const f = join(dir, `${id}.jsonl`);
    files.set(id, f);
    if (content !== undefined) writeFileSync(f, content);
    return f;
  };
  const clock = { now: Date.UTC(2026, 10, 19, 12) };
  const appended: string[] = [];
  const logs: string[] = [];
  const judge = vi.fn(async (): Promise<ConvQaVerdict> => null);
  const make = (over: Partial<ConvIngesterDeps> = {}): ConvIngester =>
    new ConvIngester({
      repo, sessions, transcriptOf: (id) => files.get(id) ?? null, onAppended: (r) => appended.push(r), now: () => clock.now, log: (m) => logs.push(m),
      openHeads: () => [], judge, ...extra, ...over,
    });
  for (const id of ["s1", "s2"]) sessions.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1 });
  const said = (root: string) => repo.page(root, { limit: 200 }).messages.map((m) => [m.role, m.text]);
  const turns = () =>
    db.prepare(`SELECT kind, asked, mutated, other_tools AS otherTools, qa, qa_by AS qaBy FROM conv_turns ORDER BY id`).all() as unknown as
      { kind: string; asked: number; mutated: number; otherTools: number; qa: string; qaBy: string | null }[];
  return { db, sessions, repo, files, file, make, clock, appended, logs, said, turns, judge };
}

describe("ConvIngester.ingest", () => {
  it("stores what both sides said in the fixture and builds the turns", async () => {
    const e = env();
    e.file("s1", readFileSync(FIXTURE, "utf8"));
    await e.make().ingest("s1");
    expect(e.said("s1")).toEqual([
      ["user", "换新阈值是多少？"],
      ["assistant", "我看一下"],
      ["assistant", "150k。"],
      ["user", "把按钮改成蓝色"],
      ["assistant", "改好了"],
      ["assistant", "收到"],
      ["user", "[image]"],
      ["assistant", "这是一张截图"],
    ]);
    // 每一轮都 end_turn 了，规则当场判掉；都不需要问模型。
    expect(e.turns()).toEqual([
      { kind: "user", asked: 1, mutated: 0, otherTools: 0, qa: "yes", qaBy: "rule" },
      { kind: "user", asked: 0, mutated: 1, otherTools: 0, qa: "no", qaBy: "rule" },
      { kind: "silent", asked: 0, mutated: 0, otherTools: 0, qa: "no", qaBy: "rule" },
      { kind: "silent", asked: 0, mutated: 0, otherTools: 0, qa: "no", qaBy: "rule" },
      { kind: "user", asked: 0, mutated: 0, otherTools: 0, qa: "no", qaBy: "rule" },
    ]);
    const msgs = e.repo.page("s1", { limit: 200 }).messages;
    expect(msgs[5].turnId).not.toBe(msgs[4].turnId);
    expect(new Set(e.appended)).toEqual(new Set(["s1"]));
    expect(e.judge).not.toHaveBeenCalled();
  });

  it("does not store the handoff the agent writes after /handoff", async () => {
    const e = env();
    e.file("s1", readFileSync(REFRESH_TAIL, "utf8"));
    await e.make().ingest("s1");
    const said = e.said("s1");
    expect(said.map(([, t]) => t)).toContain("PR #12 开好了，等 CI。");
    expect(said.some(([, t]) => t.includes("shipherd-handoff"))).toBe(false);
    expect(e.turns().at(-1)).toMatchObject({ kind: "handoff", qa: "no" });
  });

  it("picks up after a restart from the cursor and its open turn", async () => {
    const e = env();
    const f = e.file("s1", jsonl(user("u1", null, "换新阈值是多少？", 1), reply("a1", "u1", "150k。", 2, false)));
    await e.make().ingest("s1");
    await e.make().ingest("s1");
    expect(e.said("s1")).toHaveLength(2);
    appendFileSync(f, jsonl(reply("a2", "a1", "补充一句。", 3)));
    await e.make().ingest("s1");
    const msgs = e.repo.page("s1", { limit: 200 }).messages;
    expect(msgs.map((m) => m.text)).toEqual(["换新阈值是多少？", "150k。", "补充一句。"]);
    expect(new Set(msgs.map((m) => m.turnId)).size).toBe(1);
  });

  it("stores a line written in two halves once", async () => {
    const e = env();
    const line = user("u1", null, "这是什么？", 1);
    const f = e.file("s1", line.slice(0, 20));
    const ing = e.make();
    await ing.ingest("s1");
    expect(e.said("s1")).toEqual([]);
    appendFileSync(f, `${line.slice(20)}\n`);
    await ing.ingest("s1");
    await ing.ingest("s1");
    expect(e.said("s1")).toEqual([["user", "这是什么？"]]);
  });

  it("a replaced file does not end the turn that is still open (final review 2)", async () => {
    const e = env();
    const base = jsonl(user("u1", null, "第一问？", 1), reply("a1", "u1", "第一答", 2), user("u2", "a1", "第二问？", 3));
    const f = e.file("s1", base);
    const ing = e.make();
    await ing.ingest("s1");
    const other = join(tempDir("shipherd-conv-"), "n.jsonl");
    writeFileSync(other, base + jsonl(tool("t1", "u2", "Read", { file_path: "/x" }, 4)));
    renameSync(other, f);
    await ing.ingest("s1");
    const open = e.repo.turn(e.repo.page("s1", { limit: 10 }).messages.at(-1)!.turnId);
    expect(open?.endedAt).toBeNull();
    expect(e.turns().at(-1)).toMatchObject({ qa: "pending" });
  });

  it("handles a replaced file and a shortened file without duplicates or deletions", async () => {
    const e = env();
    const base = jsonl(user("u1", null, "第一问？", 1), reply("a1", "u1", "第一答", 2));
    const f = e.file("s1", base);
    const ing = e.make();
    await ing.ingest("s1");
    const other = join(tempDir("shipherd-conv-"), "n.jsonl");
    writeFileSync(other, base + jsonl(user("u2", "a1", "第二问？", 3), reply("a2", "u2", "第二答", 4)));
    renameSync(other, f);
    await ing.ingest("s1");
    expect(e.said("s1").map(([, t]) => t)).toEqual(["第一问？", "第一答", "第二问？", "第二答"]);
    truncateSync(f, Buffer.byteLength(base));
    await ing.ingest("s1");
    expect(e.said("s1").map(([, t]) => t)).toEqual(["第一问？", "第一答", "第二问？", "第二答"]);
  });

  it("files a /clear chain under its root and keeps the resume prompt out", async () => {
    const e = env();
    e.file("s1", jsonl(user("u1", null, "第一问？", 1), reply("a1", "u1", "第一答", 2)));
    const ing = e.make();
    await ing.ingest("s1");
    e.sessions.setReplacedBy("s1", "s2");
    e.file("s2", jsonl(user("v1", null, M().refreshResume("ticket", "PROJ-1", null), 3), reply("b1", "v1", "接上了", 4), user("v2", "b1", "现在到哪了？", 5)));
    await ing.ingest("s2");
    expect(e.said("s1").map(([, t]) => t)).toEqual(["第一问？", "第一答", "接上了", "现在到哪了？"]);
    expect(e.said("s2")).toEqual([]);
    const resumed = e.repo.page("s1", { limit: 200 }).messages[2];
    expect(e.repo.turn(resumed.turnId)).toMatchObject({ kind: "silent", sessionId: "s2" });
  });

  it("does not repeat history that a resume copied into the new file", async () => {
    const e = env();
    const head = jsonl(user("u1", null, "第一问？", 1), reply("a1", "u1", "第一答", 2));
    e.file("s1", head);
    const ing = e.make();
    await ing.ingest("s1");
    e.sessions.setReplacedBy("s1", "s2");
    e.file("s2", head + jsonl(user("u2", "a1", "第二问？", 3), reply("a2", "u2", "第二答", 4)));
    await ing.ingest("s2");
    expect(e.said("s1").map(([, t]) => t)).toEqual(["第一问？", "第一答", "第二问？", "第二答"]);
  });

  it("moves a segment read before its link to the chain root", async () => {
    const e = env();
    e.file("s2", jsonl(user("v1", null, "后来的问题？", 3), reply("b1", "v1", "后来的回答", 4)));
    const ing = e.make();
    await ing.ingest("s2");
    expect(e.said("s2")).toHaveLength(2);
    e.sessions.setReplacedBy("s1", "s2");
    e.appended.length = 0;
    await ing.ingest("s2");
    expect(e.said("s1").map(([, t]) => t)).toEqual(["后来的问题？", "后来的回答"]);
    expect(e.said("s2")).toEqual([]);
    expect(e.appended).toEqual(["s1"]);
  });

  it("moves a segment to the chain root even after its transcript is gone (PR #60 review 4)", async () => {
    const e = env();
    e.file("s2", jsonl(user("v1", null, "后来的问题？", 3), reply("b1", "v1", "后来的回答", 4)));
    const ing = e.make();
    await ing.ingest("s2");
    e.files.delete("s2");
    e.sessions.setReplacedBy("s1", "s2");
    await ing.ingest("s2");
    expect(e.said("s1").map(([, t]) => t)).toEqual(["后来的问题？", "后来的回答"]);
    expect(e.said("s2")).toEqual([]);
  });

  it("files interleaved replies under the turn they answer", async () => {
    const e = env();
    e.file("s1", jsonl(user("ua", null, "x？", 1), user("ub", null, "y？", 2), reply("ra", "ua", "答 x", 3), reply("rb", "ub", "答 y", 4)));
    await e.make().ingest("s1");
    const msgs = e.repo.page("s1", { limit: 200 }).messages;
    const turnOf = (t: string) => msgs.find((m) => m.text === t)!.turnId;
    expect(e.repo.turnMessages(turnOf("x？")).map((m) => m.text)).toEqual(["x？", "答 x"]);
    expect(e.repo.turnMessages(turnOf("y？")).map((m) => m.text)).toEqual(["y？", "答 y"]);
  });

  it("serialises concurrent ingests of one session", async () => {
    const e = env();
    const f = e.file("s1", jsonl(user("u1", null, "第一问？", 1), reply("a1", "u1", "第一答", 2)));
    const ing = e.make();
    await Promise.all([ing.ingest("s1"), ing.ingest("s1")]);
    expect(e.said("s1")).toHaveLength(2);
    const at = e.repo.cursor("s1")!.offset;
    appendFileSync(f, jsonl(user("u2", "a1", "第二问？", 3)));
    await Promise.all([ing.ingest("s1"), ing.ingest("s1"), ing.ingest("s1")]);
    expect(e.said("s1")).toHaveLength(3);
    expect(e.repo.cursor("s1")!.offset).toBeGreaterThan(at);
  });

  it("keeps going past bad lines", async () => {
    const e = env();
    e.file("s1", jsonl(user("u1", null, "第一问？", 1), "{bad", JSON.stringify({ type: "assistant", message: { content: 42 } }), reply("a1", "u1", "第一答", 2)));
    await e.make().ingest("s1");
    expect(e.said("s1").map(([, t]) => t)).toEqual(["第一问？", "第一答"]);
  });

  it("reads lines longer than a chunk and skips lines over the limit", async () => {
    const e = env({ chunkBytes: 64, maxLineBytes: 10_000 });
    const mid = "中".repeat(1600);
    e.file("s1", jsonl(user("u1", null, "长吗？", 1), reply("a1", "u1", mid, 2, false), reply("a2", "a1", "x".repeat(20_000), 3, false), reply("a3", "a2", "完了", 4)));
    await e.make().ingest("s1");
    expect(e.said("s1").map(([, t]) => t)).toEqual(["长吗？", mid, "完了"]);
    expect(e.logs.filter((l) => l.includes("skipped"))).toHaveLength(1);
  });

  it("caps a very long answer", async () => {
    const e = env();
    e.file("s1", jsonl(user("u1", null, "写长点？", 1), reply("a1", "u1", "长".repeat(30_000), 2)));
    await e.make().ingest("s1");
    const text = e.said("s1")[1][1];
    expect([...text].length).toBeLessThanOrEqual(CONV_TEXT_MAX + 40);
    expect(text).toContain("chars omitted");
  });

  it("downgrades a Q&A turn that later changes files", async () => {
    const e = env();
    const f = e.file("s1", jsonl(user("u1", null, "这是什么？", 1), reply("a1", "u1", "是个函数", 2, false)));
    const ing = e.make();
    await ing.ingest("s1");
    const turnId = e.repo.page("s1", { limit: 200 }).messages[0].turnId;
    e.repo.setQa(turnId, "yes", "judge");
    e.appended.length = 0;
    appendFileSync(f, jsonl(tool("a2", "a1", "Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }, 3)));
    await ing.ingest("s1");
    expect(e.repo.turn(turnId)).toMatchObject({ qa: "no", qaBy: "rule", mutated: true });
    expect(e.appended).toEqual(["s1"]);
  });
});

function fakeWatch() {
  const live = new Map<string, (type: "change" | "rename") => void>();
  const watch: ConvIngesterDeps["watch"] = (file, onEvent) => {
    live.set(file, onEvent);
    return { close: () => live.delete(file) };
  };
  return { watch, live };
}

afterEach(() => vi.useRealTimers());

describe("ConvIngester scheduling", () => {
  it("backfills every segment of a target's chain on start, under the root", async () => {
    const e = env();
    e.sessions.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: e.clock.now, lastActivityAt: e.clock.now });
    e.sessions.insertIfAbsent({ id: "h", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: e.clock.now, lastActivityAt: e.clock.now });
    e.sessions.setReplacedBy("a", "h");
    e.file("a", jsonl(user("u1", null, "第一问？", 1), reply("a1", "u1", "第一答", 2)));
    e.file("h", jsonl(user("u2", null, "第二问？", 3), reply("a2", "u2", "第二答", 4)));
    const ivs: number[] = [];
    const timers = { setInterval: ((_: () => void, ms: number) => (ivs.push(ms), ivs.length)) as unknown as typeof setInterval, clearInterval: (() => undefined) as typeof clearInterval };
    const started = e.make({ timers });
    started.start();
    await started.sweep();
    expect(e.said("a").map(([, t]) => t)).toEqual(["第一问？", "第一答", "第二问？", "第二答"]);
    expect(ivs.sort((x, y) => x - y)).toEqual([CONV_TICK_MS, CONV_SWEEP_MS]);
    started.stop();
  });

  it("leaves sessions that are not targets alone", async () => {
    const e = env();
    e.sessions.insertIfAbsent({ id: "stray", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: e.clock.now, lastActivityAt: e.clock.now });
    e.sessions.recordHeadless("headless", "/w", e.clock.now);
    e.file("stray", jsonl(user("u1", null, "第一问？", 1)));
    e.file("headless", jsonl(user("u2", null, "第二问？", 1)));
    const ing = e.make();
    await ing.sweep();
    expect(e.db.prepare(`SELECT COUNT(*) AS n FROM conv_messages`).get()).toEqual({ n: 0 });
    expect(e.repo.cursor("stray")).toBeNull();
    expect(e.repo.cursor("headless")).toBeNull();
  });

  it("skips targets that were last active before the backfill window", async () => {
    const e = env();
    e.sessions.insertIfAbsent({ id: "old", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1, lastActivityAt: e.clock.now - CONV_BACKFILL_MS - 1 });
    e.file("old", jsonl(user("u1", null, "第一问？", 1)));
    await e.make().sweep();
    expect(e.repo.cursor("old")).toBeNull();
  });

  it("watches open heads, reads on change, and drops the watch once the head closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const e = env();
    const w = fakeWatch();
    const heads = ["s1"];
    const f = e.file("s1", jsonl(user("u1", null, "第一问？", 1)));
    const watched = e.make({ watch: w.watch, openHeads: () => heads });
    await watched.tick();
    expect(w.live.has(f)).toBe(true);
    expect(e.said("s1")).toHaveLength(1);
    appendFileSync(f, jsonl(reply("a1", "u1", "第一答", 2)));
    w.live.get(f)!("change");
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(e.said("s1")).toHaveLength(2));
    heads.length = 0;
    await watched.tick();
    expect(w.live.has(f)).toBe(false);
  });

  it("catches up on the next tick when the watch missed the write", async () => {
    const e = env();
    const w = fakeWatch();
    const f = e.file("s1", jsonl(user("u1", null, "第一问？", 1)));
    const ing = e.make({ watch: w.watch, openHeads: () => ["s1"] });
    await ing.tick();
    appendFileSync(f, jsonl(reply("a1", "u1", "第一答", 2)));
    await ing.tick();
    expect(e.said("s1")).toHaveLength(2);
  });

  it("catches a tick that throws: logs it once per window and never rejects", async () => {
    const e = env();
    e.file("s1", jsonl(user("u1", null, "第一问？", 1)));
    const ing = e.make({ openHeads: () => ["s1"] });
    vi.spyOn(e.repo, "cursor").mockImplementation(() => {
      throw new RangeError("Value is too large to be represented as a JavaScript number: 18858823440414828");
    });
    for (let i = 0; i < 5; i++) await expect(ing.tick()).resolves.toBeUndefined();
    expect(e.logs.filter((l) => l.startsWith("conv tick:"))).toHaveLength(1);
    e.clock.now += 11 * 60_000;
    await ing.tick();
    expect(e.logs.filter((l) => l.startsWith("conv tick:"))).toHaveLength(2);
  });

  it("does not re-ingest a file whose cursor holds a legacy rounded ino", async () => {
    const e = env();
    const f = e.file("s1", jsonl(user("u1", null, "第一问？", 1)));
    const ing = e.make({ openHeads: () => ["s1"] });
    await ing.tick();
    const c = e.repo.cursor("s1")!;
    expect(c.ino.startsWith("i")).toBe(true);
    const legacy = String(Number(c.ino.slice(1)));
    e.db.prepare(`UPDATE conv_cursors SET ino = ? WHERE session_id = 's1'`).run(Number(legacy));
    const spy = vi.spyOn(ing, "ingest");
    await ing.tick();
    expect(spy).not.toHaveBeenCalled();
    expect(f).toBeTruthy();
  });

  it("does not watch open heads that are not targets", async () => {
    const e = env();
    const w = fakeWatch();
    e.sessions.insertIfAbsent({ id: "stray", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 1 });
    e.file("stray", jsonl(user("u1", null, "第一问？", 1)));
    const ing = e.make({ watch: w.watch, openHeads: () => ["stray"] });
    await ing.tick();
    expect(w.live.size).toBe(0);
    expect(e.repo.cursor("stray")).toBeNull();
  });

  describe("judging", () => {
    /** 一轮：用户说了 q，agent 回了 a；tools 是 agent 回答前调的工具。 */
    const turn = (q: string, a: string, tools: [string, unknown][] = []) =>
      jsonl(user("u1", null, q, 1), ...tools.map(([name, input], i) => tool(`t${i}`, i === 0 ? "u1" : `t${i - 1}`, name, input, 2)), reply("a1", tools.length ? `t${tools.length - 1}` : "u1", a, 3));

    it("does not ask the model when the rules decide", async () => {
      const e = env();
      e.file("s1", turn("这是什么？", "是个函数"));
      const ing = e.make();
      await ing.ingest("s1");
      await ing.runJudges();
      expect(e.turns()[0]).toMatchObject({ qa: "yes", qaBy: "rule" });
      expect(e.judge).not.toHaveBeenCalled();
    });

    it("writes the model's verdict and tells the page", async () => {
      const e = env();
      e.judge.mockResolvedValue(true);
      e.file("s1", turn("讲讲换新的流程", "先写 handoff，再开新会话"));
      const ing = e.make();
      e.appended.length = 0;
      await ing.ingest("s1");
      await ing.runJudges();
      expect(e.turns()[0]).toMatchObject({ qa: "yes", qaBy: "judge" });
      expect(e.judge).toHaveBeenCalledWith({ question: "讲讲换新的流程", answer: "先写 handoff，再开新会话" }, { cwd: "/w", ticketKey: null });
      expect(e.appended.filter((r) => r === "s1").length).toBeGreaterThanOrEqual(2);
    });

    it("gives up on a turn the model could not judge", async () => {
      const e = env();
      e.judge.mockResolvedValue(null);
      e.file("s1", turn("讲讲换新的流程", "先写 handoff，再开新会话"));
      const ing = e.make();
      await ing.ingest("s1");
      await ing.runJudges();
      await ing.runJudges();
      expect(e.turns()[0]).toMatchObject({ qa: "no", qaBy: "judge_failed" });
      expect(e.judge).toHaveBeenCalledTimes(1);
    });

    it("keeps a turn pending while the cost breaker is paused, and tries again later", async () => {
      const e = env();
      e.judge.mockResolvedValue("paused");
      e.file("s1", turn("讲讲换新的流程", "先写 handoff，再开新会话"));
      const ing = e.make();
      await ing.ingest("s1");
      await ing.runJudges();
      expect(e.turns()[0]).toMatchObject({ qa: "pending" });
      const calls = e.judge.mock.calls.length;
      // 暂停期间不是每次 ingest 都去碰一次熔断（final review 1）。
      await ing.runJudges();
      expect(e.judge.mock.calls.length).toBe(calls);
      e.clock.now += CONV_PAUSE_RETRY_MS;
      await ing.runJudges();
      expect(e.judge.mock.calls.length).toBe(calls + 1);
    });

    it("one paused ticket does not hold back other sessions' turns (final review 1)", async () => {
      const e = env();
      e.db.prepare(`INSERT INTO tickets (key, repo_path, work_mode, branch, created_at) VALUES ('PROJ-1', '/r', 'branch', 'b', 1)`).run();
      e.sessions.insertIfAbsent({ id: "p1", ticketKey: "PROJ-1", cwd: "/w", origin: "shipherd", createdAt: 1 });
      const judge = vi.fn(async (_t: unknown, s: { ticketKey: string | null }): Promise<ConvQaVerdict> => (s.ticketKey === "PROJ-1" ? "paused" : true));
      e.file("p1", turn("讲讲换新的流程", "先写 handoff，再开新会话"));
      e.file("s1", jsonl(user("u1", null, "讲讲合并的流程", 5), reply("a1", "u1", "等 CI 过了再合", 6), user("u2", "a1", "这是什么？", 7), reply("a2", "u2", "是个函数", 8)));
      const ing = e.make({ judge });
      await ing.ingest("p1");
      await ing.ingest("s1");
      await ing.runJudges();
      await vi.waitFor(() => expect(e.turns().map((t) => [t.qa, t.qaBy])).toEqual([["pending", null], ["yes", "judge"], ["yes", "rule"]]));
    });

    it("a pending turn the rules already passed to the model is not re-read on every ingest until it changes (BTL-242)", async () => {
      const e = env();
      e.judge.mockImplementation(() => new Promise<ConvQaVerdict>(() => undefined));
      const f = e.file("s1", turn("讲讲换新的流程", "先写 handoff，再开新会话"));
      e.file("s2", turn("讲讲合并的流程", "等 CI 过了再合"));
      const ing = e.make();
      await ing.ingest("s1");
      await vi.waitFor(() => expect(e.judge).toHaveBeenCalledTimes(1));
      const [first] = e.db.prepare(`SELECT id FROM conv_turns ORDER BY id`).all() as { id: number }[];
      const spy = vi.spyOn(e.repo, "turnMessages");
      await ing.ingest("s2");
      expect(spy.mock.calls.map((c) => c[0])).not.toContain(first.id);
      // 这一轮又读进了新内容：再按规则判一次。
      spy.mockClear();
      appendFileSync(f, jsonl(reply("a9", "a1", "补一句", 9)));
      await ing.ingest("s1");
      expect(spy.mock.calls.map((c) => c[0])).toContain(first.id);
    });

    it("rule verdicts land right after the read even while a model judge is in flight (final review 8)", async () => {
      const e = env();
      e.judge.mockImplementation(() => new Promise<ConvQaVerdict>(() => undefined));
      const f = e.file("s1", turn("讲讲换新的流程", "先写 handoff，再开新会话"));
      const ing = e.make();
      await ing.ingest("s1");
      await vi.waitFor(() => expect(e.judge).toHaveBeenCalledTimes(1));
      appendFileSync(f, jsonl(user("u2", "a1", "这是什么？", 5), reply("a2", "u2", "是个函数", 6)));
      await ing.syncNow("s1");
      expect(e.turns().map((t) => [t.qa, t.qaBy])).toEqual([["pending", null], ["yes", "rule"]]);
    });

    it("runs one judge at a time", async () => {
      const e = env();
      let release: (v: ConvQaVerdict) => void = () => undefined;
      e.judge.mockImplementation(() => new Promise<ConvQaVerdict>((r) => (release = r)));
      e.file("s1", jsonl(user("u1", null, "讲讲换新", 1), reply("a1", "u1", "先写 handoff", 2), user("u2", "a1", "再讲讲合并", 3), reply("a2", "u2", "等 CI 过了再合", 4)));
      const ing = e.make();
      await ing.ingest("s1");
      const second = ing.runJudges();
      await Promise.resolve();
      expect(e.judge).toHaveBeenCalledTimes(1);
      release(false);
      await vi.waitFor(() => expect(e.judge).toHaveBeenCalledTimes(2));
      release(false);
      await second;
      await vi.waitFor(() => expect(e.turns().map((t) => t.qa)).toEqual(["no", "no"]));
    });

    it("does not judge turns that ended long ago", async () => {
      const e = env();
      e.clock.now = Date.parse(ts(3)) + CONV_JUDGE_MAX_AGE_MS + 3600_000;
      e.file("s1", turn("讲讲换新的流程", "先写 handoff，再开新会话"));
      const ing = e.make();
      await ing.ingest("s1");
      await ing.runJudges();
      expect(e.turns()[0]).toMatchObject({ qa: "no", qaBy: "old" });
      expect(e.judge).not.toHaveBeenCalled();
    });

    it("an old turn the rules can decide still gets the rule verdict (PR #60 review 1)", async () => {
      const e = env();
      e.clock.now = Date.parse(ts(3)) + CONV_JUDGE_MAX_AGE_MS + 3600_000;
      e.file("s1", turn("这是什么？", "是个函数"));
      const ing = e.make();
      await ing.ingest("s1");
      await ing.runJudges();
      expect(e.turns()[0]).toMatchObject({ qa: "yes", qaBy: "rule" });
      expect(e.judge).not.toHaveBeenCalled();
    });

    it("a turn left for later gives up once it is too old (PR #60 review 3)", async () => {
      const e = env();
      e.judge.mockResolvedValue("paused");
      e.file("s1", turn("讲讲换新的流程", "先写 handoff，再开新会话"));
      const ing = e.make();
      await ing.ingest("s1");
      await ing.runJudges();
      expect(e.turns()[0]).toMatchObject({ qa: "pending" });
      e.clock.now = Date.parse(ts(3)) + CONV_JUDGE_MAX_AGE_MS + 1;
      await ing.runJudges();
      expect(e.turns()[0]).toMatchObject({ qa: "no", qaBy: "old" });
      expect(e.judge).toHaveBeenCalledTimes(1);
    });

    it("ends a turn that never stopped once it has been quiet long enough, then judges it", async () => {
      const e = env();
      e.judge.mockResolvedValue(true);
      e.sessions.insertIfAbsent({ id: "h", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: e.clock.now, lastActivityAt: e.clock.now });
      e.clock.now = Date.parse(ts(3)) + 60_000;
      e.file("h", jsonl(user("u1", null, "讲讲换新的流程", 1), reply("a1", "u1", "先写 handoff，再开新会话", 2, false)));
      const ing = e.make();
      await ing.sweep();
      expect(e.repo.turn(e.repo.page("h", { limit: 10 }).messages[0].turnId)?.endedAt).toBeNull();
      e.clock.now += CONV_STALE_TURN_MS;
      await ing.sweep();
      expect(e.turns().at(-1)).toMatchObject({ qa: "yes", qaBy: "judge" });
    });

    it("does not end a quiet turn while its terminal is still open (PR #60 review 5)", async () => {
      const e = env();
      e.judge.mockResolvedValue(true);
      e.sessions.insertIfAbsent({ id: "h", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: e.clock.now, lastActivityAt: e.clock.now });
      e.clock.now = Date.parse(ts(3)) + CONV_STALE_TURN_MS + 60_000;
      // 一次很长的工具调用：开了头，还没回来。
      e.file("h", jsonl(user("u1", null, "跑一下全量 e2e", 1), tool("t1", "u1", "Bash", { command: "pnpm e2e" }, 2)));
      let open = ["h"];
      const ing = e.make({ openHeads: () => open });
      await ing.sweep();
      const turnId = e.repo.cursor("h")!.openTurnId!;
      expect(e.repo.turn(turnId)?.endedAt).toBeNull();
      open = [];
      await ing.sweep();
      expect(e.repo.turn(turnId)?.endedAt).not.toBeNull();
    });

    it("re-checks the turn after the model answers: a file change in the meantime wins", async () => {
      const e = env();
      let release: (v: ConvQaVerdict) => void = () => undefined;
      e.judge.mockImplementation(() => new Promise<ConvQaVerdict>((r) => (release = r)));
      const f = e.file("s1", turn("讲讲换新的流程", "先写 handoff，再开新会话"));
      const ing = e.make();
      await ing.ingest("s1");
      await vi.waitFor(() => expect(e.judge).toHaveBeenCalledTimes(1));
      appendFileSync(f, jsonl(tool("t9", "a1", "Write", { file_path: "/repo/x.ts", content: "x" }, 4)));
      await ing.ingest("s1");
      release(true);
      await vi.waitFor(() => expect(e.turns()[0]).toMatchObject({ qa: "no", qaBy: "rule" }));
    });
  });

  it("drops the in-memory parent maps of sessions that are not open after a sweep (final review 6)", async () => {
    const e = env();
    e.sessions.insertIfAbsent({ id: "h1", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: e.clock.now, lastActivityAt: e.clock.now });
    e.sessions.insertIfAbsent({ id: "h2", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: e.clock.now, lastActivityAt: e.clock.now });
    e.file("h1", jsonl(user("u1", null, "第一问？", 1), reply("a1", "u1", "第一答", 2)));
    e.file("h2", jsonl(user("v1", null, "第二问？", 1), reply("b1", "v1", "第二答", 2)));
    const ing = e.make({ openHeads: () => ["h2"] });
    await ing.sweep();
    const parents = (ing as unknown as { parents: Map<string, unknown> }).parents;
    expect([...parents.keys()]).toEqual(["h2"]);
  });

  it("syncNow reads the whole chain up to now without a watch", async () => {
    const e = env();
    e.sessions.setReplacedBy("s1", "s2");
    e.file("s1", jsonl(user("u1", null, "第一问？", 1)));
    const f2 = e.file("s2", jsonl(user("u2", null, "第二问？", 2)));
    const ing = e.make();
    await ing.syncNow("s1");
    appendFileSync(f2, jsonl(reply("a2", "u2", "第二答", 3)));
    await ing.syncNow("s2");
    expect(e.said("s1").map(([, t]) => t)).toEqual(["第一问？", "第二问？", "第二答"]);
  });

  it("touches nothing after stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const e = env();
    const w = fakeWatch();
    const f = e.file("s1", jsonl(user("u1", null, "第一问？", 1)));
    const timers = { setInterval: (() => 1) as unknown as typeof setInterval, clearInterval: vi.fn() as unknown as typeof clearInterval };
    const ing = e.make({ watch: w.watch, openHeads: () => ["s1"], timers });
    await ing.tick();
    ing.stop();
    appendFileSync(f, jsonl(reply("a1", "u1", "第一答", 2)));
    w.live.get(f)?.("change");
    vi.advanceTimersByTime(1000);
    await ing.tick();
    await ing.ingest("s1");
    await ing.sweep();
    await ing.runJudges();
    expect(e.said("s1")).toHaveLength(1);
    expect(w.live.size).toBe(0);
  });

  it("stop clears the timers start set", () => {
    const e = env();
    const cleared: unknown[] = [];
    const timers = { setInterval: ((_: () => void, ms: number) => `iv${ms}`) as unknown as typeof setInterval, clearInterval: ((id: unknown) => cleared.push(id)) as typeof clearInterval };
    const ing = e.make({ timers });
    ing.start();
    ing.stop();
    expect(cleared.sort()).toEqual([`iv${CONV_SWEEP_MS}`, `iv${CONV_TICK_MS}`].sort());
  });
});
