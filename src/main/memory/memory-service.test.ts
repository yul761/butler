import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Handoff } from "../../shared/handoff";
import type { Followup, FollowupStatus, HandoffTrigger } from "../../shared/types";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { MemorySyncRepo } from "../db/memory-sync-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb, tempDir } from "../test-utils";
import { handoffSummary, MemoryService } from "./memory-service";
import { NOTES_CAP, withScope, type ScopeHandle } from "./statecore";

// 故障注入的接缝：withScope 默认就是真的；个别测试把真实句柄包一层（StateCore 本身始终是真的嵌入式存储）。
vi.mock("./statecore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./statecore")>();
  return { ...actual, withScope: vi.fn(actual.withScope) };
});
const realStatecore = await vi.importActual<typeof import("./statecore")>("./statecore");
/** 之后打开的 scope 里，match 的那些换成 wrap(真实句柄)。 */
function wrapScopes(match: (scope: string) => boolean, wrap: (s: ScopeHandle) => ScopeHandle): void {
  vi.mocked(withScope).mockImplementation(((o: Parameters<typeof withScope>[0], fn: (s: ScopeHandle) => Promise<unknown>) =>
    realStatecore.withScope(o, (s) => fn(match(o.scope) ? wrap(s) : s))) as typeof withScope);
}
afterEach(() => {
  vi.mocked(withScope).mockImplementation(realStatecore.withScope);
});

// StateCore 的 pino 直接读 process.env.LOG_LEVEL（不看 env 选项），在它加载之前静音。
vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

const payload = (over: Partial<Handoff> = {}): Handoff => ({
  ticket: "PROJ-1", status: "active", done_today: [], next_steps: [], blockers: [], pr: null, jira: null,
  followups: [], decisions: [], learnings: [], open_questions: [], ...over,
});

function setup(o: { dataDir?: string; enabled?: boolean } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const sync = new MemorySyncRepo(db);
  for (const key of ["PROJ-1", "PROJ-2"]) {
    tickets.insert({ key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  }
  const dataDir = o.dataDir ?? tempDir();
  const logs: string[] = [];
  let enabled = o.enabled ?? true;
  // 交接的 createdAt 默认晚于此前 StateCore 的所有写入，和产品里一样（后来的交接产生在前一次写入之后）。
  // StateCore 的时钟是单调的（同一毫秒内多次写入时 +1），本文件里成批的写入会让它跑到真实时钟前面，所以留一分钟余量。
  let now = Date.now();
  const synced: string[] = [];
  const memory = new MemoryService({
    dataDir, tickets, handoffs, followups, sync,
    enabled: () => enabled,
    now: () => now,
    onSynced: (key) => synced.push(key),
    log: (m, e) => logs.push(e === undefined ? m : `${m} ${e instanceof Error ? e.message : String(e)}`),
  });
  const addHandoff = (p: Handoff, trigger: HandoffTrigger = "nightly", key = "PROJ-1", createdAt = (now = Math.max(now + 1, Date.now() + 60_000))) =>
    handoffs.insert({ ticketKey: key, sessionId: null, trigger, createdAt, payload: p, rawText: null })!;
  const addFollowup = (id: string, over: Partial<Followup> = {}) =>
    followups.insert({
      id, ticketKey: "PROJ-1", kind: "config", description: `描述 ${id}`, trigger: "after_merge", dueDate: null,
      status: "open", snoozedUntil: null, source: "session", createdAt: ++now, doneAt: null, ...over,
    });
  const setFollowup = (id: string, status: FollowupStatus) => followups.setStatus(id, status, ++now);
  const texts = (scope = "ticket:PROJ-1") => withScope({ dataDir, scope }, async (s) => (await s.facts()).map((i) => i.text));
  const items = (scope = "ticket:PROJ-1") => withScope({ dataDir, scope }, (s) => s.facts());
  const slots = (scope = "ticket:PROJ-1") => withScope({ dataDir, scope }, (s) => s.noteSlots());
  return { memory, dataDir, sync, logs, synced, addHandoff, addFollowup, setFollowup, texts, items, slots, setEnabled: (v: boolean) => (enabled = v) };
}

describe("handoffSummary", () => {
  it("states the status and what was done", () => {
    expect(handoffSummary(payload({ status: "in_review", done_today: ["写完接口", " ", "补测试"] }))).toBe("状态：in_review。完成：写完接口；补测试");
    expect(handoffSummary(payload())).toBe("状态：active。");
  });
});

describe("MemoryService.syncTicket (design 8.3)", () => {
  it("writes the handoff, decisions, open followups and learnings of a ticket", async () => {
    const t = setup();
    t.addFollowup("f_1", { description: "改 staging 配置" });
    const id = t.addHandoff(payload({
      done_today: ["接口写完"], next_steps: ["补测试"], open_questions: ["要不要拆 PR？"],
      decisions: [{ key: "db", statement: "用 PostgreSQL" }], learnings: ["gh pr checks 要带 --required"],
    }));
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["[followup:f_1] 改 staging 配置（配置，合并后）", "[decision:db] 用 PostgreSQL"]);
    expect(await t.texts("workspace")).toEqual(["[learning:PROJ-1] gh pr checks 要带 --required"]);
    const view = await t.memory.view("PROJ-1");
    expect(view).toMatchObject({ enabled: true, scope: "ticket:PROJ-1", error: null });
    expect(view.handoff?.content).toBe("状态：active。完成：接口写完\nOpen questions:\n- 要不要拆 PR？\nNext steps:\n- 补测试");
    expect(t.sync.cursor("PROJ-1")).toBe(id);
    expect(t.synced).toEqual(["PROJ-1"]);
  });

  it("replaces a changed decision and keeps the old one on the why chain", async () => {
    const t = setup();
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL 存储会话" }] }));
    await t.memory.syncTicket("PROJ-1");
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 MySQL 存储会话" }] }));
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["[decision:db] 用 MySQL 存储会话"]);
    const view = await t.memory.view("PROJ-1");
    const chain = await t.memory.why("PROJ-1", view.items[0].factId!);
    expect(chain?.map((e) => e.content)).toEqual(["[decision:db] 用 PostgreSQL 存储会话", "[decision:db] 用 MySQL 存储会话"]);
    // 交接也有自己的链：两次 handoff 两个版本。
    expect(view.handoff?.versionCount).toBe(2);
  });

  it("forgets a followup once it is done or ignored, and leaves other notes alone", async () => {
    const t = setup();
    t.addFollowup("f_1");
    t.addFollowup("f_2");
    t.addHandoff(payload());
    await t.memory.syncTicket("PROJ-1");
    await withScope({ dataDir: t.dataDir, scope: "ticket:PROJ-1" }, async (s) => {
      await s.remember("Claude 自己记的：这个仓库用 pnpm");
    });
    t.setFollowup("f_1", "done");
    t.setFollowup("f_2", "ignored");
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["Claude 自己记的：这个仓库用 pnpm"]);
  });

  it("a reopened followup becomes visible again (Review Focus 2)", async () => {
    const t = setup();
    t.addFollowup("f_1", { description: "部署后打开开关" });
    await t.memory.syncTicket("PROJ-1");
    t.setFollowup("f_1", "done");
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual([]);
    t.setFollowup("f_1", "open");
    await t.memory.syncTicket("PROJ-1");
    const reopened = await t.texts();
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatch(/^\[followup:f_1#2( [a-z]{4}){3}\] 部署后打开开关（配置，合并后）$/);
    // 再同步一次：变体被当作已经写好的那条，不会再写 #3。
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(reopened);
  });

  it("keeps two followups with almost the same text both visible", async () => {
    const t = setup();
    for (const id of ["f_1", "f_2", "f_3"]) t.addFollowup(id);
    await t.memory.syncTicket("PROJ-1");
    const texts = await t.texts();
    expect(texts).toHaveLength(3);
    expect(texts.map((x) => /^\[followup:(f_\d)/.exec(x)?.[1]).sort()).toEqual(["f_1", "f_2", "f_3"]);
    expect(t.logs.filter((l) => l.includes("stays hidden"))).toEqual([]);
    // 已经分开了：再同步不改动任何条目。
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(texts);
  });

  it("is idempotent: a second sync with nothing new writes nothing", async () => {
    const t = setup();
    t.addFollowup("f_1");
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL" }], learnings: ["经验一"] }));
    await t.memory.syncTicket("PROJ-1");
    const before = await t.memory.view("PROJ-1");
    await t.memory.syncTicket("PROJ-1");
    const after = await t.memory.view("PROJ-1");
    expect(after.items).toEqual(before.items);
    expect(after.handoff).toEqual(before.handoff);
    expect(await t.texts("workspace")).toEqual(["[learning:PROJ-1] 经验一"]);
  });

  it("writes only the latest handoff, skips refreshes and degraded ones, and replays at most 20 handoffs of learnings", async () => {
    const t = setup();
    for (let i = 0; i < 25; i++) t.addHandoff(payload({ learnings: [`经验 ${i}`] }));
    t.addHandoff(payload({ status: "blocked", learnings: ["刷新里的"] }), "refresh");
    await t.memory.syncTicket("PROJ-1");
    const ws = await t.texts("workspace");
    expect(ws).toHaveLength(20);
    expect(ws[0]).toBe("[learning:PROJ-1] 经验 5");
    expect(ws).not.toContain("[learning:PROJ-1] 刷新里的");
    const view = await t.memory.view("PROJ-1");
    expect(view.handoff).toMatchObject({ content: "状态：active。", versionCount: 1 });
  });

  it("rewrites the latest handoff when the StateCore data was deleted", async () => {
    const first = tempDir();
    const t = setup({ dataDir: first });
    t.addHandoff(payload({ done_today: ["a"] }));
    await t.memory.syncTicket("PROJ-1");
    // 换一个空的数据目录，相当于用户删掉了 ~/.butler/statecore。
    const t2 = setup({ dataDir: tempDir() });
    t2.addHandoff(payload({ done_today: ["a"] }));
    t2.sync.setCursor("PROJ-1", 999, 1);
    await t2.memory.syncTicket("PROJ-1");
    expect((await t2.memory.view("PROJ-1")).handoff?.content).toBe("状态：active。完成：a");
  });

  it("does nothing when memory is turned off or the ticket is unknown", async () => {
    const t = setup({ enabled: false });
    t.addFollowup("f_1");
    t.addHandoff(payload({ learnings: ["x"] }));
    await t.memory.syncTicket("PROJ-1");
    await t.memory.syncTicket("NOPE-1");
    expect(t.sync.cursor("PROJ-1")).toBe(0);
    expect(await t.memory.view("PROJ-1")).toEqual({ enabled: false, scope: "ticket:PROJ-1", handoff: null, items: [], error: null });
    t.setEnabled(true);
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["[followup:f_1] 描述 f_1（配置，合并后）"]);
  });

  it("never rejects and keeps the cursor when StateCore cannot open (Review Focus 1)", async () => {
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "x");
    const t = setup({ dataDir: blocker });
    t.addHandoff(payload({ learnings: ["x"] }));
    await expect(t.memory.syncTicket("PROJ-1")).resolves.toBeUndefined();
    expect(t.sync.cursor("PROJ-1")).toBe(0);
    expect(t.logs.some((l) => l.startsWith("memory sync PROJ-1 failed"))).toBe(true);
    expect(t.synced).toEqual([]);
    const view = await t.memory.view("PROJ-1");
    expect(view.enabled).toBe(true);
    expect(view.error).toBeTruthy();
  });

  it("merges repeated requests for a ticket that is still waiting in the queue", async () => {
    const t = setup();
    const a = t.memory.syncTicket("PROJ-1");
    const b = t.memory.syncTicket("PROJ-1");
    expect(b).toBe(a);
    const c = t.memory.syncTicket("PROJ-2");
    expect(c).not.toBe(a);
    await Promise.all([a, c]);
    await t.memory.idle();
  });

  it("syncs every unarchived ticket and skips everything after stop()", async () => {
    const t = setup();
    t.addFollowup("f_1");
    await t.memory.syncAll();
    expect(await t.texts()).toEqual(["[followup:f_1] 描述 f_1（配置，合并后）"]);
    t.addFollowup("f_2");
    t.memory.stop();
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["[followup:f_1] 描述 f_1（配置，合并后）"]);
  });
});

/** 两两之间 Jaccard 很低的描述：每条都是追加，不会被 StateCore 当成别的条目的修订。 */
const distinct = (i: number) => ["north", "pixel", "river", "stone", "tiger", "vault"].map((w) => `${w}${i}q${i * 13}`).join(" ");

describe("MemoryService notes cap guard (PF2: StateCore keeps forgotten notes in the 30-note cap)", () => {
  it("never evicts a desired note while a ticket goes through more than 30 lifetime notes, and does not churn", async () => {
    const t = setup();
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL 存储会话" }] }));
    t.addFollowup("keep", { description: "上线前通知运维" });
    await t.memory.syncTicket("PROJ-1");
    const pinned = await t.items();
    expect(pinned.map((i) => i.text).sort()).toEqual(["[decision:db] 用 PostgreSQL 存储会话", "[followup:keep] 上线前通知运维（配置，合并后）"]);

    // 40 个 followup 先打开再完成：每个都占一个位置，forget 之后位置也不释放。
    for (let i = 0; i < 40; i++) {
      t.addFollowup(`tmp_${i}`, { description: distinct(i) });
      await t.memory.syncTicket("PROJ-1");
      const now = await t.items();
      // 一直写下的两条从没被挤掉、也没被重写（factId 不变）。
      for (const p of pinned) expect(now).toContainEqual(p);
      expect((await t.slots()).used).toBeLessThanOrEqual(NOTES_CAP);
      // 前 28 个写得进去（2 + 28 = 30），之后的没有位置，跳过。
      expect(now.some((x) => x.text.startsWith(`[followup:tmp_${i}]`))).toBe(i < NOTES_CAP - 2);
      t.setFollowup(`tmp_${i}`, "done");
      await t.memory.syncTicket("PROJ-1");
      expect(await t.items()).toEqual(pinned);
    }
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });

    // 输入不变时第二次同步什么都不写：条目（含 factId、时间）和占用都不变。
    t.addFollowup("late", { description: distinct(99) });
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL 存储会话" }, { key: "cache", statement: "缓存用 Redis" }] }));
    await t.memory.syncTicket("PROJ-1");
    const first = await t.items();
    expect(first).toEqual(pinned);
    await t.memory.syncTicket("PROJ-1");
    expect(await t.items()).toEqual(first);
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });
    const chain = await t.memory.why("PROJ-1", pinned.find((p) => p.text.startsWith("[decision:db]"))!.factId!);
    expect(chain).toHaveLength(1);

    // 跳过的只记条数，不记内容。
    const skipped = t.logs.filter((l) => l.includes("skipped"));
    expect(skipped.at(-1)).toBe("memory PROJ-1: no free note slot (30/30), skipped 1 followup(s), 1 decision(s)");
    expect(t.logs.some((l) => /north|上线前|Redis|tmp_/.test(l))).toBe(false);
  });

  it("when only some notes fit, writes open followups first, newest first, then decisions", async () => {
    const t = setup();
    // Claude 自己记的 29 条占掉位置，只剩 1 个。
    await withScope({ dataDir: t.dataDir, scope: "ticket:PROJ-1" }, async (s) => {
      for (let i = 0; i < NOTES_CAP - 1; i++) await s.remember(`Claude 自己记的 ${distinct(i)}`);
    });
    t.addFollowup("f_old", { description: distinct(100) });
    t.addFollowup("f_new", { description: distinct(101) });
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL" }] }));
    await t.memory.syncTicket("PROJ-1");
    const butler = (await t.texts()).filter((x) => x.startsWith("["));
    expect(butler).toEqual([`[followup:f_new] ${distinct(101)}（配置，合并后）`]);
    expect(await t.texts()).toHaveLength(NOTES_CAP);
    expect(t.logs).toContain("memory PROJ-1: no free note slot (30/30), skipped 1 followup(s), 1 decision(s)");
  });

  it("writes a displaced note back before anything else, so a tight slot budget never loses a visible note", async () => {
    const t = setup();
    t.addFollowup("f_1");
    await t.memory.syncTicket("PROJ-1");
    // 只剩 1 个位置。
    await withScope({ dataDir: t.dataDir, scope: "ticket:PROJ-1" }, async (s) => {
      for (let i = 0; i < NOTES_CAP - 2; i++) await s.remember(`Claude 自己记的 ${distinct(i)}`);
    });
    t.addFollowup("f_3", { description: distinct(3) });
    // f_2 最新、先写；它和 f_1 只差 id，StateCore 把它当成 f_1 的修订原地替换（不占位置），f_1 要马上用变体写回去。
    t.addFollowup("f_2");
    await t.memory.syncTicket("PROJ-1");
    const butler = (await t.texts()).filter((x) => x.startsWith("[followup:"));
    expect(butler.map((x) => /^\[followup:(f_\d)/.exec(x)?.[1]).sort()).toEqual(["f_1", "f_2"]);
    expect(t.logs).toContain("memory PROJ-1: no free note slot (30/30), skipped 1 followup(s), 0 decision(s)");
    const before = await t.items();
    await t.memory.syncTicket("PROJ-1");
    expect(await t.items()).toEqual(before);
  });

  it("does not rewrite a note when StateCore revises only its forgotten older text", async () => {
    const t = setup();
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL 存储会话" }] }));
    await t.memory.syncTicket("PROJ-1");
    // 改成一句完全不同的话：旧文本被 forget，但还留在 StateCore 的 notes 里。
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "改用托管集群 with read replicas and failover" }] }));
    await t.memory.syncTicket("PROJ-1");
    // 新决策和 db 的旧文本几乎一样：StateCore 把它当成那条已遗忘旧文本的修订。db 现在的那条不受影响，不该重写。
    t.addHandoff(payload({ decisions: [{ key: "db2", statement: "用 PostgreSQL 存储会话" }, { key: "db", statement: "改用托管集群 with read replicas and failover" }] }));
    await t.memory.syncTicket("PROJ-1");
    const texts = await t.texts();
    expect(texts.sort()).toEqual(["[decision:db2] 用 PostgreSQL 存储会话", "[decision:db] 改用托管集群 with read replicas and failover"]);
    const before = await t.items();
    await t.memory.syncTicket("PROJ-1");
    expect(await t.items()).toEqual(before);
  });

  it("writes at most 30 learnings of one sync into workspace, the newest ones", async () => {
    const t = setup();
    for (let i = 0; i < 20; i++) t.addHandoff(payload({ learnings: [`a${i} ${distinct(i)}`, `b${i} ${distinct(i + 50)}`] }));
    await t.memory.syncTicket("PROJ-1");
    const ws = await t.texts("workspace");
    expect(ws).toHaveLength(NOTES_CAP);
    expect(ws[0]).toBe(`[learning:PROJ-1] a5 ${distinct(5)}`);
    expect(ws.at(-1)).toBe(`[learning:PROJ-1] b19 ${distinct(69)}`);
    expect(t.logs).toContain("memory PROJ-1: skipped 10 older learning(s) of this sync");
  });
});

describe("MemoryService fix round 1 (task 4 review)", () => {
  const scope = "ticket:PROJ-1";
  const raw = <T>(dataDir: string, fn: (s: ScopeHandle) => Promise<T>) => realStatecore.withScope({ dataDir, scope }, fn);

  it("registers an unregistered note before forgetting it, so the slot count never comes out low (finding 1)", async () => {
    const t = setup();
    t.addFollowup("f_1", { description: distinct(1) });
    t.addHandoff(payload({ decisions: [{ key: "a", statement: distinct(2) }, { key: "b", statement: distinct(3) }] }));
    await t.memory.syncTicket("PROJ-1");
    const x = `[followup:f_1] ${distinct(1)}（配置，合并后）`;
    const db = `[decision:b] ${distinct(3)}`;
    expect((await t.texts()).sort()).toEqual([`[decision:a] ${distinct(2)}`, db, x].sort());
    // claude 里的 MCP（不受 Butler 的保护）写满并多写一条：挤掉最旧的 f_1；它又一字不差地写回 f_1，挤掉 decision:a。
    await raw(t.dataDir, async (s) => {
      for (let i = 0; i < NOTES_CAP - 2; i++) await s.remember(`Claude 自己记的 ${distinct(10 + i)}`);
      await s.remember(x);
    });
    const orphan = (await t.items()).find((i) => i.text === x);
    expect(orphan?.factId).toBeNull(); // StateCore 没给它登记
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });
    // f_1 完成：Butler 要 forget 它，并且想写回被挤掉的 decision:a。
    t.setFollowup("f_1", "done");
    await t.memory.syncTicket("PROJ-1");
    const texts = await t.texts();
    expect(texts).toContain(db); // 要保留的条目没被挤掉
    expect(texts.some((x2) => x2.startsWith("[followup:f_1"))).toBe(false);
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });
    expect(t.logs).toContain("memory PROJ-1: no free note slot (30/30), skipped 0 followup(s), 1 decision(s)");
  });

  it("measures free slots before every write, so a concurrent MCP write cannot make the estimate low (finding 2)", async () => {
    const t = setup();
    t.addHandoff(payload({ decisions: [{ key: "db", statement: distinct(1) }] }));
    await t.memory.syncTicket("PROJ-1");
    await raw(t.dataDir, async (s) => {
      for (let i = 0; i < NOTES_CAP - 3; i++) await s.remember(`Claude 自己记的 ${distinct(10 + i)}`);
    });
    t.addFollowup("f_a", { description: distinct(2) });
    t.addFollowup("f_b", { description: distinct(3) });
    // Butler 写第一条之后，claude 里的 MCP 同时写了一条：位置刚好满了。
    let external = false;
    wrapScopes((sc) => sc === scope, (s) => ({
      ...s,
      async remember(text) {
        const r = await s.remember(text);
        if (!external) {
          external = true;
          await s.remember(`Claude 同时记的 ${distinct(99)}`);
        }
        return r;
      },
    }));
    await t.memory.syncTicket("PROJ-1");
    const texts = await t.texts();
    expect(texts).toContain(`[decision:db] ${distinct(1)}`);
    expect(texts).toContain(`[followup:f_b] ${distinct(3)}（配置，合并后）`);
    expect(texts.some((x) => x.startsWith("[followup:f_a]"))).toBe(false);
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });
  });

  it("does not write the same handoff twice when a sync is retried after a partial failure (finding 4)", async () => {
    const t = setup();
    t.addHandoff(payload({ done_today: ["接口写完"], learnings: ["经验一"] }), "nightly", "PROJ-1", Date.now() - 1000);
    wrapScopes((sc) => sc === "workspace", (s) => ({ ...s, remember: async () => { throw new Error("workspace down"); } }));
    await t.memory.syncTicket("PROJ-1");
    expect(t.sync.cursor("PROJ-1")).toBe(0);
    expect((await t.memory.view("PROJ-1")).handoff?.versionCount).toBe(1);
    vi.mocked(withScope).mockImplementation(realStatecore.withScope);
    await t.memory.syncTicket("PROJ-1");
    expect((await t.memory.view("PROJ-1")).handoff).toMatchObject({ content: "状态：active。完成：接口写完", versionCount: 1 });
    expect(await t.texts("workspace")).toEqual(["[learning:PROJ-1] 经验一"]);
    expect(t.sync.cursor("PROJ-1")).toBeGreaterThan(0);
  });

  it("logs a full scope only when what it skips changes (finding 5)", async () => {
    const t = setup();
    await raw(t.dataDir, async (s) => {
      for (let i = 0; i < NOTES_CAP; i++) await s.remember(`Claude 自己记的 ${distinct(10 + i)}`);
    });
    t.addFollowup("f_a", { description: distinct(1) });
    const full = (n: number) => t.logs.filter((l) => l.includes("no free note slot")).length === n;
    await t.memory.syncTicket("PROJ-1");
    await t.memory.syncTicket("PROJ-1");
    await t.memory.syncTicket("PROJ-1");
    expect(full(1)).toBe(true);
    t.addFollowup("f_b", { description: distinct(2) });
    await t.memory.syncTicket("PROJ-1");
    await t.memory.syncTicket("PROJ-1");
    expect(full(2)).toBe(true);
    expect(t.logs.at(-1)).toBe("memory PROJ-1: no free note slot (30/30), skipped 2 followup(s), 0 decision(s)");
  });

  it("keeps the cursor when a reconcile fails halfway (finding 6)", async () => {
    const t = setup();
    t.addFollowup("f_1", { description: distinct(1) });
    t.addFollowup("f_2", { description: distinct(2) });
    t.addHandoff(payload({ learnings: ["经验一"] }));
    let writes = 0;
    wrapScopes((sc) => sc === scope, (s) => ({
      ...s,
      async noteSlots() {
        if (++writes > 1) throw new Error("injected halfway");
        return s.noteSlots();
      },
    }));
    await t.memory.syncTicket("PROJ-1");
    expect(t.sync.cursor("PROJ-1")).toBe(0);
    expect(t.logs).toContain("memory sync PROJ-1 failed injected halfway");
    expect(t.synced).toEqual([]);
    expect(await t.texts()).toHaveLength(1); // 只写了一条就失败了
    vi.mocked(withScope).mockImplementation(realStatecore.withScope);
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toHaveLength(2);
    expect(t.sync.cursor("PROJ-1")).toBeGreaterThan(0);
    expect(await t.texts("workspace")).toEqual(["[learning:PROJ-1] 经验一"]);
  });
});

describe("MemoryService fix round 2 (task 4 re-review)", () => {
  const scope = "ticket:PROJ-1";
  const oldDb = "[decision:db] PostgreSQL";
  /** decision:db 是只有两个词的短决策；claude 里的 MCP 把它挤出上限、又一字不差地写回来（挤掉了 decision:a），它就成了没登记的条目。 */
  async function shortOrphan() {
    const t = setup();
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "PostgreSQL" }, { key: "a", statement: distinct(2) }, { key: "b", statement: distinct(3) }] }));
    await t.memory.syncTicket("PROJ-1");
    expect((await t.texts()).sort()).toEqual([oldDb, `[decision:a] ${distinct(2)}`, `[decision:b] ${distinct(3)}`].sort());
    await realStatecore.withScope({ dataDir: t.dataDir, scope }, async (s) => {
      for (let i = 0; i < NOTES_CAP - 2; i++) await s.remember(`Claude 自己记的 ${distinct(10 + i)}`);
      await s.remember(oldDb);
    });
    expect((await t.items()).find((i) => i.text === oldDb)?.factId).toBeNull();
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });
    // 决策改成完全不同的一句：旧的那条（没登记）要 forget。
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "改用 MySQL cluster with replicas" }, { key: "a", statement: distinct(2) }, { key: "b", statement: distinct(3) }] }));
    return t;
  }

  it("retires an unregistered short decision with a punctuation-only rewrite, without taking a slot (N2)", async () => {
    const t = await shortOrphan();
    await t.memory.syncTicket("PROJ-1");
    const texts = await t.texts();
    expect(texts).not.toContain(oldDb);
    expect(texts.some((x) => x.startsWith("[decision:db]"))).toBe(false);
    expect(texts).toContain(`[decision:b] ${distinct(3)}`);
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });
    expect(t.logs).toEqual(["memory PROJ-1: no free note slot (30/30), skipped 0 followup(s), 2 decision(s)"]);
  });

  it("logs a failed registration once while it keeps failing, and keeps the note instead of undercounting (N2)", async () => {
    const t = await shortOrphan();
    // 注入：登记用的改写什么都没替换（例如修订到了另一条上）。
    wrapScopes((sc) => sc === scope, (s) => ({
      ...s,
      remember: async (text) => (text.endsWith("。") ? { superseded: null } : s.remember(text)),
    }));
    await t.memory.syncTicket("PROJ-1");
    await t.memory.syncTicket("PROJ-1");
    const failed = () => t.logs.filter((l) => l.includes("could not register"));
    expect(failed()).toEqual(["memory PROJ-1: could not register 1 unregistered note(s) before forgetting them"]);
    expect(await t.texts()).toContain(oldDb); // 没登记上就不 forget
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });
    vi.mocked(withScope).mockImplementation(realStatecore.withScope);
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).not.toContain(oldDb);
    expect(failed()).toHaveLength(1);
  });

  it("writes one handoff version per handoff even when two handoffs have the same content (N1, design 8.3)", async () => {
    const t = setup();
    t.addHandoff(payload({ next_steps: ["补测试"] }));
    await t.memory.syncTicket("PROJ-1");
    t.addHandoff(payload({ next_steps: ["补测试"] }));
    await t.memory.syncTicket("PROJ-1");
    // 没有新交接时再同步：不写。
    await t.memory.syncTicket("PROJ-1");
    expect((await t.memory.view("PROJ-1")).handoff).toMatchObject({ content: "状态：active。\nNext steps:\n- 补测试", versionCount: 2 });
  });
});
