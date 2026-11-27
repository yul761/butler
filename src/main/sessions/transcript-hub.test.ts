import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvRepo } from "../db/conv-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { UsageRepo } from "../db/usage-repo";
import { ConvIngester } from "../conversation/conv-ingester";
import { UsageScanner } from "../usage/usage-scanner";
import { memDb, tempDir } from "../test-utils";
import { TranscriptTail } from "./activity-sources";
import { TranscriptHub, type TailLine, type TailSink, type TailStat } from "./transcript-hub";

afterEach(() => vi.restoreAllMocks());

const row = (i: number, extra = "") => JSON.stringify({ i, extra });

/** 记下收到的行的消费者；from 是游标，读到后推进。 */
function recorder(from = 0, o: { skipPartial?: boolean; stopAfter?: number } = {}) {
  const got: { start: number; text: string; json: unknown }[] = [];
  let pos = from;
  let calls = 0;
  const ends: (TailStat | null)[] = [];
  const sink: TailSink = {
    begin: () => ({ offset: pos, skipPartial: o.skipPartial }),
    lines: (lines: TailLine[], next: number) => {
      calls++;
      for (const l of lines) got.push({ start: l.start, text: l.text, json: l.json() });
      pos = next;
      if (o.stopAfter !== undefined && calls >= o.stopAfter) return false;
    },
    end: (st) => void ends.push(st),
  };
  return { sink, got, ends, pos: () => pos, calls: () => calls };
}

describe("TranscriptHub", () => {
  it("reads new bytes once from the furthest-back cursor and gives each reader only what follows its own cursor", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    const lines = [row(0), row(1), row(2), row(3)];
    writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
    const second = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`);
    const hub = new TranscriptHub();
    const a = recorder(0);
    const b = recorder(second);
    hub.attach(f, "a", a.sink);
    hub.attach(f, "b", b.sink);
    const parse = vi.spyOn(JSON, "parse");
    await hub.pump(f);
    expect(a.got.map((g) => g.json)).toEqual([0, 1, 2, 3].map((i) => ({ i, extra: "" })));
    expect(b.got.map((g) => (g.json as { i: number }).i)).toEqual([2, 3]);
    // 两个消费者都要的行只解析了一次
    expect(parse).toHaveBeenCalledTimes(4);
    expect(a.pos()).toBe(b.pos());
  });

  it("keeps a half-written last line for the next pump", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    writeFileSync(f, `${row(0)}\n{"i":1`);
    const hub = new TranscriptHub();
    const a = recorder();
    hub.attach(f, "a", a.sink);
    await hub.pump(f);
    expect(a.got.map((g) => g.text)).toEqual([row(0)]);
    appendFileSync(f, `,"extra":""}\n`);
    await hub.pump(f);
    expect(a.got.map((g) => g.json)).toEqual([{ i: 0, extra: "" }, { i: 1, extra: "" }]);
  });

  it("yields to the event loop after every chunk, so a big first read never blocks in one piece", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    writeFileSync(f, Array.from({ length: 200 }, (_, i) => `${row(i, "x".repeat(80))}\n`).join(""));
    let yields = 0;
    const hub = new TranscriptHub({ chunkBytes: 1024, yieldNow: async () => void yields++ });
    const a = recorder();
    hub.attach(f, "a", a.sink);
    await hub.pump(f);
    expect(a.got).toHaveLength(200);
    // 每块不到 1KB（十来行），一块一让
    expect(a.calls()).toBeGreaterThan(15);
    expect(yields).toBe(a.calls() - 1);
  });

  it("drops the half line a tail-only reader starts in, without parsing it", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    const body = `${row(0)}\n${row(1)}\n${row(2)}\n`;
    writeFileSync(f, body);
    const hub = new TranscriptHub();
    const a = recorder(5, { skipPartial: true });
    hub.attach(f, "a", a.sink);
    const parse = vi.spyOn(JSON, "parse");
    await hub.pump(f);
    expect(a.got.map((g) => (g.json as { i: number }).i)).toEqual([1, 2]);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("skips a line longer than the limit and carries on after it", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    writeFileSync(f, `${row(0)}\n${"y".repeat(5000)}\n${row(2)}\n`);
    const hub = new TranscriptHub({ chunkBytes: 64, maxLineBytes: 1000 });
    const seen: TailLine[] = [];
    hub.attach(f, "a", { begin: () => ({ offset: 0 }), lines: (ls) => void seen.push(...ls) });
    await hub.pump(f);
    expect(seen.map((l) => (l.skipped ? "skipped" : l.text))).toEqual([row(0), "skipped", row(2)]);
  });

  it("gives the start and the end of a skipped line", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    const long = `{"a":1,${"y".repeat(200_000)},"z":2}`;
    writeFileSync(f, `${long}\n${row(1)}\n`);
    const hub = new TranscriptHub({ chunkBytes: 4096, maxLineBytes: 100_000 });
    const seen: TailLine[] = [];
    hub.attach(f, "a", { begin: () => ({ offset: 0 }), lines: (ls) => void seen.push(...ls) });
    await hub.pump(f);
    expect(seen[0]).toMatchObject({ skipped: true, start: 0, end: long.length + 1 });
    expect(seen[0].head).toBe(long.slice(0, 64 * 1024));
    expect(seen[0].tail).toBe(long.slice(-64 * 1024));
    expect(seen[1].text).toBe(row(1));
  });

  it("grows the window for a line longer than a chunk, splits on bytes and drops the \\r of CRLF", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    const long = JSON.stringify({ text: "中文".repeat(300) });
    writeFileSync(f, `${row(0)}\r\n${long}\n`);
    const hub = new TranscriptHub({ chunkBytes: 7, yieldNow: async () => {} });
    const a = recorder();
    hub.attach(f, "a", a.sink);
    await hub.pump(f);
    expect(a.got.map((g) => g.text)).toEqual([row(0), long]);
    expect(a.pos()).toBe(Buffer.byteLength(`${row(0)}\r\n${long}\n`));
  });

  it("stops feeding a reader that says so and leaves the others going", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    writeFileSync(f, Array.from({ length: 50 }, (_, i) => `${row(i)}\n`).join(""));
    const hub = new TranscriptHub({ chunkBytes: 64, yieldNow: async () => {} });
    const a = recorder(0, { stopAfter: 1 });
    const b = recorder();
    hub.attach(f, "a", a.sink);
    hub.attach(f, "b", b.sink);
    await hub.pump(f);
    expect(a.calls()).toBe(1);
    expect(b.got).toHaveLength(50);
  });

  it("merges pumps that arrive while one is running into one more read", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    writeFileSync(f, `${row(0)}\n`);
    const hub = new TranscriptHub();
    const a = recorder();
    hub.attach(f, "a", a.sink);
    const first = hub.pump(f);
    const second = hub.pump(f);
    const third = hub.pump(f);
    await Promise.all([first, second, third]);
    expect(a.ends).toHaveLength(2);
    expect(a.got).toHaveLength(1);
  });

  /** 每次让出事件循环都停住，release 放行当时停着的那些。 */
  function gate() {
    const waiting: (() => void)[] = [];
    const yieldNow = () => new Promise<void>((r) => waiting.push(r));
    const until = async (p: Promise<unknown>) => {
      let done = false;
      void p.then(() => (done = true));
      for (let i = 0; i < 1000 && !done; i++) {
        for (const r of waiting.splice(0)) r();
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(done).toBe(true);
    };
    return { yieldNow, until };
  }

  it("lets a reader near the end finish first while a reader far behind catches up, and reads it again without waiting for the catch-up", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    const lines = Array.from({ length: 100 }, (_, i) => row(i));
    writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
    const lastTwo = Buffer.byteLength(lines.slice(0, 98).map((l) => `${l}\n`).join(""));
    const g = gate();
    const hub = new TranscriptHub({ chunkBytes: 64, catchUpBytes: 200, yieldNow: g.yieldNow });
    const conv = recorder(0);
    const act = recorder(lastTwo);
    hub.attach(f, "conv", conv.sink);
    hub.attach(f, "activity", act.sink);

    await g.until(hub.pump(f, "activity"));
    expect(act.got.map((x) => (x.json as { i: number }).i)).toEqual([98, 99]);
    expect(act.ends).toHaveLength(1);
    // 对话还在从头补读。
    expect(conv.ends).toHaveLength(0);
    expect(conv.got.length).toBeLessThan(100);

    // 补读还没完，活动又要读：另起一次读，不等补读。
    appendFileSync(f, `${row(100)}\n`);
    await g.until(hub.pump(f, "activity"));
    expect(act.got.map((x) => (x.json as { i: number }).i)).toEqual([98, 99, 100]);
    expect(act.ends).toHaveLength(2);
    expect(conv.ends).toHaveLength(0);

    // 补读完以后对话再读一次，拿到补读开始以后写的那行；每行只给一次。
    await g.until(hub.pump(f));
    expect(conv.got.map((x) => (x.json as { i: number }).i)).toEqual(Array.from({ length: 101 }, (_, i) => i));
    expect(conv.ends).toHaveLength(2);
    expect(act.got).toHaveLength(3);
  });

  it("does not hold a reader already at the end behind a reader catching up", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    const text = Array.from({ length: 100 }, (_, i) => `${row(i)}\n`).join("");
    writeFileSync(f, text);
    const g = gate();
    const hub = new TranscriptHub({ chunkBytes: 64, catchUpBytes: 200, yieldNow: g.yieldNow });
    const conv = recorder(0);
    const act = recorder(Buffer.byteLength(text));
    hub.attach(f, "conv", conv.sink);
    hub.attach(f, "activity", act.sink);
    await g.until(hub.pump(f, "activity"));
    expect(act.ends).toHaveLength(1);
    expect(conv.ends).toHaveLength(0);
    await g.until(hub.pump(f));
    expect(conv.got).toHaveLength(100);
  });

  it("does not feed a key attached again until the reader it replaced has finished, so a shared cursor gets each line once", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    writeFileSync(f, Array.from({ length: 200 }, (_, i) => `${row(i)}\n`).join(""));
    const g = gate();
    const hub = new TranscriptHub({ chunkBytes: 64, catchUpBytes: 200, yieldNow: g.yieldNow });
    // 两个消费者共用一个游标（对话另存：临时挂的和 head 自己的都读写库里同一个游标）。
    let cursor = 0;
    const seen: number[] = [];
    const shared = (): TailSink => ({
      begin: () => ({ offset: cursor }),
      lines: (ls, next) => {
        for (const l of ls) seen.push((l.json() as { i: number }).i);
        cursor = next;
      },
    });
    const act = recorder(0);
    hub.attach(f, "activity", act.sink);
    const detach = hub.attach(f, "conv:h", shared());
    const first = hub.pump(f, "conv:h");
    for (let i = 0; i < 3; i++) await g.until(Promise.resolve());
    detach();
    hub.attach(f, "conv:h", shared());
    const second = hub.pump(f, "conv:h");
    await g.until(Promise.all([first, second]));
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it("waits for every reader, the one catching up included, when the pump names none", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => row(i));
    writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
    const hub = new TranscriptHub({ chunkBytes: 64, catchUpBytes: 100 });
    const conv = recorder(0);
    const act = recorder(Buffer.byteLength(lines.slice(0, 49).map((l) => `${l}\n`).join("")));
    hub.attach(f, "conv", conv.sink);
    hub.attach(f, "activity", act.sink);
    const st = await hub.pump(f);
    expect(st?.size).toBeGreaterThan(0);
    expect(conv.ends).toHaveLength(1);
    expect(conv.got).toHaveLength(50);
    expect(act.got).toHaveLength(1);
  });

  it("answers a pump waiting for one more read when its reader is detached mid-read", async () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    writeFileSync(f, Array.from({ length: 20 }, (_, i) => `${row(i)}\n`).join(""));
    const g = gate();
    const hub = new TranscriptHub({ chunkBytes: 64, yieldNow: g.yieldNow });
    const a = recorder(0);
    const detach = hub.attach(f, "a", a.sink);
    const first = hub.pump(f, "a");
    const again = hub.pump(f, "a");
    detach();
    await g.until(Promise.all([first, again]));
    expect(a.ends).toHaveLength(1);
    expect(hub.sinkKeys(f)).toEqual([]);
  });

  it("returns null and tells the readers when the file is missing", async () => {
    const hub = new TranscriptHub();
    const a = recorder();
    const f = join(tempDir("hub-"), "none.jsonl");
    hub.attach(f, "a", a.sink);
    expect(await hub.pump(f)).toBeNull();
    expect(a.ends).toEqual([null]);
  });

  it("puts one fs.watch on a file however many readers watch it", () => {
    const f = join(tempDir("hub-"), "t.jsonl");
    writeFileSync(f, "");
    const fire: (() => void)[] = [];
    const closed: number[] = [];
    const watch = vi.fn((_file: string, onEvent: (t: "change" | "rename") => void) => {
      fire.push(() => onEvent("change"));
      return { close: () => void closed.push(1) };
    });
    vi.useFakeTimers();
    try {
      const hub = new TranscriptHub();
      const seen: string[] = [];
      const a = hub.watch(f, "a", { delayMs: 10, onChange: () => void seen.push("a"), watch });
      const b = hub.watch(f, "b", { delayMs: 10, onChange: () => void seen.push("b"), watch });
      expect(a.ensure()).toBe(true);
      expect(b.ensure()).toBe(true);
      expect(watch).toHaveBeenCalledTimes(1);
      fire[0]();
      vi.advanceTimersByTime(10);
      expect(seen).toEqual(["a", "b"]);
      a.close();
      expect(closed).toHaveLength(0);
      fire[0]();
      vi.advanceTimersByTime(10);
      expect(seen).toEqual(["a", "b", "b"]);
      b.close();
      expect(closed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

const ts = (n: number): string => new Date(Date.UTC(2026, 10, 19, 11, 0, 0) + n * 1000).toISOString();
const user = (uuid: string, text: string, n: number): string =>
  JSON.stringify({ type: "user", uuid, parentUuid: null, timestamp: ts(n), message: { role: "user", content: text } });
const reply = (uuid: string, parent: string, text: string, n: number): string =>
  JSON.stringify({
    type: "assistant", uuid, parentUuid: parent, timestamp: ts(n),
    message: { id: `m-${uuid}`, model: "m", role: "assistant", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "text", text }] },
  });
const jsonl = (...lines: string[]): string => lines.map((l) => `${l}\n`).join("");

/** 三个消费者共用一个 hub，读同一个 transcript。 */
function shared() {
  const dir = tempDir("hub-shared-");
  const file = join(dir, "s1.jsonl");
  const db = memDb();
  const sessions = new SessionsRepo(db);
  sessions.insertIfAbsent({ id: "s1", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1 });
  const conv = new ConvRepo(db);
  const usage = new UsageRepo(db);
  const hub = new TranscriptHub();
  const appended: string[] = [];
  const ingester = new ConvIngester({
    repo: conv, sessions, transcriptOf: () => file, onAppended: (r) => void appended.push(r), now: () => Date.UTC(2026, 10, 19, 12),
    openHeads: () => ["s1"], judge: async () => null, watch: () => ({ close() {} }), hub,
  });
  const scanner = new UsageScanner({ repo: usage, sessionIds: () => ["s1"], transcriptFile: () => file, hub });
  const said = () => conv.page("s1", { limit: 200 }).messages.map((m) => m.text);
  const used = () => usage.since(0).filter((r) => r.sessionId === "s1").length;
  return { file, hub, conv, usage, sessions, ingester, scanner, said, used, appended };
}

describe("TranscriptHub shared by activity, conversation and usage", () => {
  it("parses each new line once and hands it to all three readers", async () => {
    const e = shared();
    writeFileSync(e.file, jsonl(user("u1", "问个问题？", 1), reply("a1", "u1", "回答", 2)));
    // 开着的 head：conv 在 tick 里挂上，usage 扫一次挂上
    await e.ingester.tick();
    await e.scanner.scanAll();
    const tail = new TranscriptTail(e.file, undefined, e.hub);
    await tail.read();
    expect(e.hub.sinkKeys(e.file).sort()).toEqual(["activity", "conv:s1", "usage"]);
    appendFileSync(e.file, jsonl(user("u2", "再问一个？", 3), reply("a2", "u2", "再答", 4)));
    const parse = vi.spyOn(JSON, "parse");
    // 只有活动在读：另外两个也顺带拿到了新行
    const { state } = await tail.read();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(state.lastReply).toBe("再答");
    expect(e.said()).toEqual(["问个问题？", "回答", "再问一个？", "再答"]);
    expect(e.appended.at(-1)).toBe("s1");
    // 用量攒在内存里，扫描时写进库；不用再读文件
    expect(e.used()).toBe(1);
    await e.scanner.scanAll();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(e.used()).toBe(2);
    e.ingester.stop();
    e.scanner.stop();
    tail.close();
    expect(e.hub.sinkKeys(e.file)).toEqual([]);
  });

  it("starts the conversation over from a file truncated in place, even when the first read sees only half a line", async () => {
    const e = shared();
    writeFileSync(e.file, jsonl(user("u1", "第一句话很长很长很长很长很长很长很长很长很长很长很长很长", 1), reply("a1", "u1", "第一句回答很长很长很长很长很长很长很长很长", 2)));
    await e.ingester.ingest("s1");
    const old = e.conv.cursor("s1")!;
    expect(old.offset).toBeGreaterThan(0);
    // 原地截断（inode 不变），新内容还只写了半行
    writeFileSync(e.file, `{"type":"user"`);
    await e.ingester.ingest("s1");
    // 重置当场存下：偏移 0、没有打开的轮
    expect(e.conv.cursor("s1")).toMatchObject({ offset: 0, openTurnId: null, ino: old.ino });
    // 新文件长到超过旧的偏移：从新文件开头读，一句不丢
    writeFileSync(e.file, jsonl(user("n1", "新文件的第一句话".repeat(40), 5), reply("b1", "n1", "新文件的回答", 6)));
    expect(Buffer.byteLength(jsonl(user("n1", "新文件的第一句话".repeat(40), 5)))).toBeGreaterThan(old.offset);
    await e.ingester.ingest("s1");
    expect(e.said()).toContain("新文件的第一句话".repeat(40));
    expect(e.said()).toContain("新文件的回答");
  });

  it("starts usage over from a file truncated in place, even when the first scan sees only half a line", async () => {
    const e = shared();
    writeFileSync(e.file, jsonl(reply("a1", "u1", "第一句回答很长很长很长很长很长很长很长很长很长很长", 1), reply("a2", "u1", "又一句", 2)));
    await e.scanner.scanAll();
    expect(e.used()).toBe(2);
    const old = e.usage.cursor(e.file)!;
    writeFileSync(e.file, `{"type":"assistant"`);
    await e.scanner.scanAll();
    expect(e.usage.cursor(e.file)).toEqual({ offset: 0, size: Buffer.byteLength(`{"type":"assistant"`) });
    writeFileSync(e.file, jsonl(reply("n1", "u9", "新文件的回答".repeat(40), 5)));
    expect(Buffer.byteLength(jsonl(reply("n1", "u9", "新文件的回答".repeat(40), 5)))).toBeGreaterThan(old.offset);
    await e.scanner.scanAll();
    expect(e.used()).toBe(3);
  });

  it("tells the new chain root about its messages when another reader's read finds the session moved under it, even with no new lines", async () => {
    const e = shared();
    writeFileSync(e.file, jsonl(user("u1", "问？", 1), reply("a1", "u1", "答", 2)));
    await e.ingester.tick();
    const tail = new TranscriptTail(e.file, undefined, e.hub);
    await tail.read();
    // 之后才连上 replaced_by：s0 → s1，链根变成 s0；文件没有新内容，活动读了一次。
    e.sessions.insertIfAbsent({ id: "s0", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 0 });
    e.sessions.setReplacedBy("s0", "s1");
    e.appended.length = 0;
    await tail.read();
    expect(e.conv.cursor("s1")?.rootSessionId).toBe("s0");
    expect(e.appended).toEqual(["s0"]);
    e.ingester.stop();
    tail.close();
  });

  it("starts over for every reader when the file is replaced by a new one", async () => {
    const e = shared();
    writeFileSync(e.file, jsonl(user("u1", "旧文件？", 1), reply("a1", "u1", "旧回答", 2)));
    const tail = new TranscriptTail(e.file, undefined, e.hub);
    await e.ingester.tick();
    await tail.read();
    const tmp = `${e.file}.new`;
    writeFileSync(tmp, jsonl(user("u2", "新文件？", 3)));
    renameSync(tmp, e.file);
    await tail.read();
    expect(tail.restarts).toBe(1);
    expect(e.conv.cursor("s1")?.offset).toBe(Buffer.byteLength(jsonl(user("u2", "新文件？", 3))));
    expect(e.said()).toEqual(["旧文件？", "旧回答", "新文件？"]);
    e.ingester.stop();
  });
});
