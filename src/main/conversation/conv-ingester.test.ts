import { appendFileSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConvRepo } from "../db/conv-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { M } from "../strings";
import { memDb, tempDir } from "../test-utils";
import { CONV_TEXT_MAX } from "./conv-parse";
import { ConvIngester, type ConvIngesterDeps } from "./conv-ingester";

const FIXTURE = join(__dirname, "__fixtures__", "conv.jsonl");
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
  const dir = tempDir("butler-conv-");
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
  const make = (): ConvIngester =>
    new ConvIngester({ repo, sessions, transcriptOf: (id) => files.get(id) ?? null, onAppended: (r) => appended.push(r), now: () => clock.now, log: (m) => logs.push(m), ...extra });
  for (const id of ["s1", "s2"]) sessions.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1 });
  const said = (root: string) => repo.page(root, { limit: 200 }).messages.map((m) => [m.role, m.text]);
  const turns = () =>
    db.prepare(`SELECT kind, asked, mutated, other_tools AS otherTools, qa, qa_by AS qaBy FROM conv_turns ORDER BY id`).all() as unknown as
      { kind: string; asked: number; mutated: number; otherTools: number; qa: string; qaBy: string | null }[];
  return { db, sessions, repo, file, make, clock, appended, logs, said, turns };
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
    expect(e.turns()).toEqual([
      { kind: "user", asked: 1, mutated: 0, otherTools: 0, qa: "pending", qaBy: null },
      { kind: "user", asked: 0, mutated: 1, otherTools: 0, qa: "pending", qaBy: null },
      { kind: "silent", asked: 0, mutated: 0, otherTools: 0, qa: "no", qaBy: "rule" },
      { kind: "silent", asked: 0, mutated: 0, otherTools: 0, qa: "no", qaBy: "rule" },
      { kind: "user", asked: 0, mutated: 0, otherTools: 0, qa: "pending", qaBy: null },
    ]);
    const msgs = e.repo.page("s1", { limit: 200 }).messages;
    expect(msgs[5].turnId).not.toBe(msgs[4].turnId);
    expect(e.appended).toEqual(["s1"]);
  });

  it("does not store the handoff the agent writes after /handoff", async () => {
    const e = env();
    e.file("s1", readFileSync(REFRESH_TAIL, "utf8"));
    await e.make().ingest("s1");
    const said = e.said("s1");
    expect(said.map(([, t]) => t)).toContain("PR #12 开好了，等 CI。");
    expect(said.some(([, t]) => t.includes("butler-handoff"))).toBe(false);
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

  it("handles a replaced file and a shortened file without duplicates or deletions", async () => {
    const e = env();
    const base = jsonl(user("u1", null, "第一问？", 1), reply("a1", "u1", "第一答", 2));
    const f = e.file("s1", base);
    const ing = e.make();
    await ing.ingest("s1");
    const other = join(tempDir("butler-conv-"), "n.jsonl");
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
