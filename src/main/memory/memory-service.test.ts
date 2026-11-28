import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureHandoff, Handoff } from "../../shared/handoff";
import type { Followup, FollowupStatus, HandoffTrigger } from "../../shared/types";
import { EpicArchiveRepo } from "../db/epic-archive-repo";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { MemorySyncRepo } from "../db/memory-sync-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { epicScope, featureScope, NOTE_BODY_LIMIT } from "../../shared/memory";
import { insertTicket, memDb, tempDir } from "../test-utils";
import { EPIC_ARCHIVE_AT, EPIC_ARCHIVE_KEEP, EPIC_ARCHIVE_MAX, handoffSummary, MemoryService } from "./memory-service";
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
/**
 * 每个用例的 statecore.db 上一直开着一条空闲连接（BTL-268）。产品里通常也是这样：claude 里挂的记忆 MCP 进程开着同一个库，主进程的“打开 → 做事 → 关闭”不是最后一条连接。
 * 没有它，每次 withScope 关闭都是最后一条连接：SQLite 要做 checkpoint、删掉 -wal 和 -shm，下次打开、第一次写入时再从空文件建起来。
 * 这些在 Windows 上很贵（建文件、删文件、刷盘都慢）：CI 实测关一次库 6–8 ms、写一次 15–24 ms，“more than 30 lifetime notes”一条用例开关库 169 次、写 86 次，
 * 单独跑就要 3–3.6 秒，整套并行、runner 一忙就到了 30 秒的上限；开着这条连接后关库约 0.1 ms、写入约 7 ms，这条用例约 1.2 秒。
 * 连接不开事务，不挡 StateCore 的读写和 checkpoint。dataDir 不是目录（有用例故意放了个文件）时不开。
 */
const keepers: DatabaseSync[] = [];
function keepOpen(dataDir: string): void {
  // 只跳过“dataDir 不是目录”这一种；别的打不开要报出来，不然用例照样过、却悄悄退回慢路径。
  if (!statSync(dataDir, { throwIfNoEntry: false })?.isDirectory()) return;
  const db = new DatabaseSync(join(dataDir, "statecore.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  // 读一次才会映射 -shm，之后一直占着它。
  db.prepare("SELECT count(*) FROM sqlite_master").get();
  keepers.push(db);
}
afterEach(() => {
  vi.mocked(withScope).mockImplementation(realStatecore.withScope);
  for (const db of keepers.splice(0)) {
    try {
      db.close();
    } catch {
      // 一条关不掉不影响关其他的。
    }
  }
});

// StateCore 的 pino 直接读 process.env.LOG_LEVEL（不看 env 选项），在它加载之前静音。
vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

const payload = (over: Partial<Handoff> = {}): Handoff => ({
  ticket: "PROJ-1", status: "active", done_today: [], next_steps: [], blockers: [], prs: [], jira: null,
  followups: [], decisions: [], learnings: [], open_questions: [], ...over,
});

function setup(o: { dataDir?: string; enabled?: boolean } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const sync = new MemorySyncRepo(db);
  const features = new FeaturesRepo(db);
  const featureHandoffs = new FeatureHandoffsRepo(db);
  const epicArchive = new EpicArchiveRepo(db);
  // feature 1、2、3；测试里主要用 3。
  for (const name of ["F1", "F2", "F3"]) features.insert({ name, workspaceDir: `/w/${name}`, createdAt: 1 });
  for (const key of ["PROJ-1", "PROJ-2"]) {
    insertTicket(tickets, { key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  }
  const dataDir = o.dataDir ?? tempDir();
  keepOpen(dataDir);
  const logs: string[] = [];
  let enabled = o.enabled ?? true;
  // 交接的 createdAt 默认晚于此前 StateCore 的所有写入，和产品里一样（后来的交接产生在前一次写入之后）。
  // StateCore 的时钟是单调的（同一毫秒内多次写入时 +1），本文件里成批的写入会让它跑到真实时钟前面，所以留一分钟余量。
  let now = Date.now();
  const synced: string[] = [];
  const memory = new MemoryService({
    dataDir, tickets, handoffs, followups, sync, features, featureHandoffs, epicArchive,
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
  // 汇总的时间用真实时钟：同一份内容是否已经写过，要拿 StateCore 写入的时间和它比（见 syncFeature）。
  const addSummary = (p: FeatureHandoff | null, featureId = 3, createdAt = Date.now()) =>
    featureHandoffs.insert({ featureId, sessionId: null, trigger: "nightly", createdAt, payload: p, rawText: null })!;
  const texts = (scope = "ticket:PROJ-1") => withScope({ dataDir, scope }, async (s) => (await s.facts()).map((i) => i.text));
  const items = (scope = "ticket:PROJ-1") => withScope({ dataDir, scope }, (s) => s.facts());
  const slots = (scope = "ticket:PROJ-1") => withScope({ dataDir, scope }, (s) => s.noteSlots());
  return {
    memory, dataDir, sync, logs, synced, features, epicArchive, db, addHandoff, addFollowup, setFollowup, addSummary, texts, items, slots,
    setEnabled: (v: boolean) => (enabled = v),
  };
}

const summary = (over: Partial<FeatureHandoff> = {}): FeatureHandoff => ({
  summary: "接口联调完了，前端在等错误码", blockers: [], next_steps: [], decisions: [], open_questions: [], ...over,
});

describe("MemoryService.syncFeature (design 2026-10-28, 记忆)", () => {
  const scope = featureScope(3);
  const handoffOf = (t: ReturnType<typeof setup>) => withScope({ dataDir: t.dataDir, scope }, (s) => s.activeHandoff());

  it("writes the latest summary as the handoff of the epic scope, its decisions under Conventions instead of notes (BTL-246)", async () => {
    const t = setup();
    t.addSummary(summary({
      next_steps: [{ ticket: "PROJ-1", text: "补后端的错误码" }, { ticket: null, text: "约前端联调" }],
      open_questions: ["要不要拆成两个 PR？"],
      decisions: [{ key: "errors", statement: "错误码统一用 E 开头的四位数" }, { key: "api", statement: "接口走 REST" }],
    }));
    await t.memory.syncFeature(3);
    expect((await handoffOf(t))?.content).toBe(
      "接口联调完了，前端在等错误码\n\n约定：\n- 错误码统一用 E 开头的四位数\n- 接口走 REST\nOpen questions:\n- 要不要拆成两个 PR？\nNext steps:\n- 补后端的错误码\n- 约前端联调",
    );
    // Shipherd 不再占 epic 记忆的笔记位。
    expect(await t.texts(scope)).toEqual([]);
    // 不碰 ticket scope 和 workspace。
    expect(await t.texts("workspace")).toEqual([]);
    expect(t.synced).toEqual([scope]);
  });

  it("forgets the decision notes Shipherd wrote before, and leaves Claude's notes alone", async () => {
    const t = setup();
    await withScope({ dataDir: t.dataDir, scope }, async (s) => {
      await s.remember("[decision:errors] 错误码用四位数");
      await s.remember("前端的表单都用 zod 校验");
    });
    t.addSummary(summary({ summary: "前端接上了", decisions: [{ key: "errors", statement: "错误码用五位数" }] }));
    await t.memory.syncFeature(3);
    expect(await t.texts(scope)).toEqual(["前端的表单都用 zod 校验"]);
    expect(await handoffOf(t)).toMatchObject({ content: "前端接上了\n\n约定：\n- 错误码用五位数", versionCount: 1 });
  });

  it("writes the handoff once per summary: a second sync with nothing new does not write it again", async () => {
    const t = setup();
    t.addSummary(summary({ decisions: [{ key: "api", statement: "接口走 REST" }] }));
    await t.memory.syncFeature(3);
    const before = await handoffOf(t);
    await t.memory.syncFeature(3);
    expect(await handoffOf(t)).toEqual(before);
    expect(before?.versionCount).toBe(1);
    expect(await t.texts(scope)).toEqual([]);
  });

  it("a later summary with the same text still gets its own handoff version", async () => {
    const t = setup();
    t.addSummary(summary());
    await t.memory.syncFeature(3);
    // 晚于上一次写入之后生成的汇总（StateCore 的时钟可能略快于真实时钟，留一分钟余量）。
    t.addSummary(summary(), 3, Date.now() + 60_000);
    await t.memory.syncFeature(3);
    expect((await handoffOf(t))?.versionCount).toBe(2);
  });

  it("skips degraded summaries: the latest valid one is what counts", async () => {
    const t = setup();
    t.addSummary(summary({ summary: "有效的那份" }));
    t.addSummary(null);
    await t.memory.syncFeature(3);
    expect((await handoffOf(t))?.content).toBe("有效的那份");
  });

  it("rewrites the handoff when the StateCore data was deleted", async () => {
    const t = setup();
    t.addSummary(summary());
    await t.memory.syncFeature(3);
    const t2 = setup({ dataDir: tempDir() });
    t2.addSummary(summary());
    await t2.memory.syncFeature(3);
    expect((await handoffOf(t2))?.content).toBe("接口联调完了，前端在等错误码");
  });

  it("does nothing when memory is off, for an unknown feature, or before the first valid summary", async () => {
    const off = setup({ enabled: false });
    off.addSummary(summary({ decisions: [{ key: "api", statement: "接口走 REST" }] }));
    await off.memory.syncFeature(3);
    expect(await handoffOf(off)).toBeNull();
    expect(await off.texts(scope)).toEqual([]);
    expect(off.synced).toEqual([]);
    const t = setup();
    await t.memory.syncFeature(99);
    t.addSummary(null);
    await t.memory.syncFeature(3);
    expect(await handoffOf(t)).toBeNull();
    expect(t.synced).toEqual([]);
  });

  it("syncAll also syncs the features that are not archived", async () => {
    const t = setup();
    t.addSummary(summary({ summary: "feature 3" }), 3);
    t.addSummary(summary({ summary: "feature 2" }), 2);
    t.features.archive(2, 1);
    await t.memory.syncAll();
    expect((await handoffOf(t))?.content).toBe("feature 3");
    expect(await withScope({ dataDir: t.dataDir, scope: featureScope(2) }, (s) => s.activeHandoff())).toBeNull();
  });
});

describe("MemoryService epic memory: Plan, Conventions and the overflow archive (BTL-246 §5)", () => {
  const scope = featureScope(3);
  const handoffOf = (t: ReturnType<typeof setup>) => withScope({ dataDir: t.dataDir, scope }, (s) => s.activeHandoff());
  const words = (i: number) => ["amber", "birch", "cedar", "delta", "ember", "fjord"].map((w) => `${w}${i}x${i * 7}`).join(" ");
  const fill = (t: ReturnType<typeof setup>, n: number, sc = scope) =>
    withScope({ dataDir: t.dataDir, scope: sc }, async (s) => {
      for (let i = 0; i < n; i++) await s.remember(`约定 ${i}：${words(i)}`);
    });

  it("renders the brief under Plan even before the first summary, in the current language", async () => {
    const t = setup();
    t.db.prepare("UPDATE features SET brief = ? WHERE id = 3").run("先做购物车，再做支付");
    await t.memory.syncFeature(3);
    expect((await handoffOf(t))?.content).toBe("规划：\n先做购物车，再做支付");
    expect(t.synced).toEqual([scope]);
  });

  it(`moves the oldest notes into the archive at ${EPIC_ARCHIVE_AT}, keeping ${EPIC_ARCHIVE_KEEP}, and renders them under Earlier conventions`, async () => {
    const t = setup();
    await fill(t, EPIC_ARCHIVE_AT - 1);
    await t.memory.syncFeature(3);
    // 还没到：不动。
    expect(await t.texts(scope)).toHaveLength(EPIC_ARCHIVE_AT - 1);
    expect(t.epicArchive.list(3)).toEqual([]);
    await withScope({ dataDir: t.dataDir, scope }, (s) => s.remember(`最新的约定 ${words(99)}`));
    await t.memory.syncFeature(3);
    const left = await t.texts(scope);
    expect(left).toHaveLength(EPIC_ARCHIVE_KEEP);
    expect(left).toContain(`最新的约定 ${words(99)}`);
    const moved = t.epicArchive.list(3);
    expect(moved.map((e) => e.text)).toEqual(Array.from({ length: EPIC_ARCHIVE_AT - EPIC_ARCHIVE_KEEP }, (_, i) => `约定 ${i}：${words(i)}`));
    expect(moved.every((e) => e.source === "notes")).toBe(true);
    const content = (await handoffOf(t))!.content;
    expect(content).toContain("以前的约定（从 epic 记忆里挪出来的旧笔记；要改哪一条，用 remember 记下新版本）：");
    expect(content).toContain(`] 约定 0：${words(0)}`);
    expect(content).toMatch(/\n- \[\d{4}-\d{2}-\d{2}\] 约定 5：/);
    // 再同步一次：没有新东西，不多写版本。
    const before = await handoffOf(t);
    await t.memory.syncFeature(3);
    expect(await handoffOf(t)).toEqual(before);
  });

  it(`keeps the newest ${EPIC_ARCHIVE_MAX} archived notes and logs the ones it drops`, async () => {
    const t = setup();
    for (let i = 0; i < EPIC_ARCHIVE_MAX; i++) t.epicArchive.add({ featureId: 3, text: `旧约定 ${i}`, source: "notes", notedAt: i + 1, archivedAt: 1 });
    await fill(t, EPIC_ARCHIVE_AT);
    await t.memory.syncFeature(3);
    const kept = t.epicArchive.list(3);
    expect(kept).toHaveLength(EPIC_ARCHIVE_MAX);
    expect(kept.map((e) => e.text)).not.toContain("旧约定 0");
    expect(t.logs.some((l) => l.includes("dropped") && l.includes(scope))).toBe(true);
  });

  it("copies the notes of an old epic into the archive of each of its features once, at the start-up sync", async () => {
    const t = setup();
    t.db.prepare("INSERT INTO epics (id, name, workspace_dir, created_at) VALUES (7, 'Big', '/w/big', 1)").run();
    t.db.prepare("UPDATE features SET epic_id = 7 WHERE id IN (2, 3)").run();
    await withScope({ dataDir: t.dataDir, scope: epicScope(7) }, async (s) => {
      await s.remember("所有接口都走 /api/v2");
      await s.remember("[decision:old] Shipherd 写的旧决策");
    });
    await t.memory.syncAll();
    for (const f of [2, 3]) expect(t.epicArchive.list(f).map((e) => [e.text, e.source])).toEqual([["所有接口都走 /api/v2", "epic:7"]]);
    expect((await handoffOf(t))!.content).toContain("所有接口都走 /api/v2");
    // 第二次启动不再搬。
    await t.memory.syncAll();
    expect(t.epicArchive.list(3)).toHaveLength(1);
    // 旧 epic 记忆本身不动。
    expect(await t.texts(epicScope(7))).toHaveLength(2);
  });

  it("an old epic with no notes is still recorded as copied, and nothing is shown", async () => {
    const t = setup();
    t.db.prepare("INSERT INTO epics (id, name, workspace_dir, created_at) VALUES (8, 'Empty', '/w/e', 1)").run();
    t.db.prepare("UPDATE features SET epic_id = 8 WHERE id = 3").run();
    await t.memory.syncAll();
    expect(t.epicArchive.has(3, "epic:8")).toBe(true);
    expect(t.epicArchive.list(3)).toEqual([]);
    expect(await handoffOf(t)).toBeNull();
  });
});

describe("MemoryService.rememberText and recallText (fork light mode)", () => {
  it("writes a plain note that view shows, and reconcile leaves alone", async () => {
    const t = setup();
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL" }] }));
    expect(await t.memory.rememberText("ticket:PROJ-1", "结论：先改接口再改界面")).toBe("written");
    expect((await t.memory.view("PROJ-1")).items.map((i) => i.text)).toContain("结论：先改接口再改界面");
    await t.memory.syncTicket("PROJ-1");
    const texts = await t.texts();
    expect(texts).toContain("结论：先改接口再改界面");
    expect(texts).toContain("[decision:db] 用 PostgreSQL");
  });

  it("skips a fact that is already there, checking inside the write queue (BTL-272)", async () => {
    const t = setup();
    expect(await t.memory.rememberText("ticket:PROJ-1", "接口一律分页")).toBe("written");
    const seen: string[][] = [];
    const dup = (e: readonly string[]) => {
      seen.push([...e]);
      return e.find((x) => x.includes("分页")) ?? null;
    };
    const [a, b] = await Promise.all([
      t.memory.rememberUnlessDup("ticket:PROJ-1", "导出放右上角", (e) => e.find((x) => x.includes("右上角")) ?? null),
      t.memory.rememberUnlessDup("ticket:PROJ-1", "导出放右上角。", (e) => e.find((x) => x.includes("右上角")) ?? null),
    ]);
    expect([a.result, b.result]).toEqual(["written", "dup"]);
    expect(b.dupOf).toBe("导出放右上角");
    expect(await t.memory.rememberUnlessDup("ticket:PROJ-1", "接口分页", dup)).toEqual({ result: "dup", dupOf: "接口一律分页" });
    expect((await t.texts()).sort()).toEqual(["导出放右上角", "接口一律分页"]);
  });

  it("forgets only the notes the matcher picks, and returns null when memory is off (BTL-272)", async () => {
    const t = setup();
    await t.memory.rememberText("ticket:PROJ-1", "BTL-12 不做了（来自 S 的对话）");
    await t.memory.rememberText("ticket:PROJ-1", "导出放右上角");
    expect(await t.memory.forgetText("ticket:PROJ-1", (x) => x.startsWith("BTL-12"))).toBe(1);
    expect(await t.texts()).toEqual(["导出放右上角"]);
    expect(await t.memory.forgetText("ticket:PROJ-1", () => false)).toBe(0);
    const off = setup({ enabled: false });
    expect(await off.memory.forgetText("ticket:PROJ-1", () => true)).toBeNull();
  });

  it("cuts the text to NOTE_BODY_LIMIT", async () => {
    const t = setup();
    expect(await t.memory.rememberText("ticket:PROJ-1", "字".repeat(NOTE_BODY_LIMIT + 50))).toBe("written");
    expect(await t.texts()).toEqual(["字".repeat(NOTE_BODY_LIMIT)]);
  });

  it("returns full when no slot is left, without pushing anything out", async () => {
    const t = setup();
    await withScope({ dataDir: t.dataDir, scope: "ticket:PROJ-1" }, async (s) => {
      for (let i = 0; i < NOTES_CAP; i++) await s.remember(`已有 ${distinct(i)}`);
    });
    const before = await t.texts();
    expect(await t.memory.rememberText("ticket:PROJ-1", "新的一条")).toBe("full");
    expect(await t.texts()).toEqual(before);
  });

  it("returns disabled when memory is off", async () => {
    const t = setup({ enabled: false });
    expect(await t.memory.rememberText("ticket:PROJ-1", "x")).toBe("disabled");
    expect(await t.texts()).toEqual([]);
  });

  it("returns failed instead of rejecting when StateCore throws", async () => {
    const t = setup();
    vi.mocked(withScope).mockRejectedValueOnce(new Error("boom"));
    await expect(t.memory.rememberText("ticket:PROJ-1", "x")).resolves.toBe("failed");
    expect(t.logs.some((l) => l.includes("boom"))).toBe(true);
  });

  it("rejects blank text without writing", async () => {
    const t = setup();
    expect(await t.memory.rememberText("ticket:PROJ-1", "   ")).toBe("failed");
    expect(await t.texts()).toEqual([]);
  });

  it("still ends up visible when the text equals a forgotten note (StateCore hides those)", async () => {
    const t = setup();
    await withScope({ dataDir: t.dataDir, scope: "ticket:PROJ-1" }, async (s) => {
      await s.remember("结论甲");
      const [it] = await s.facts();
      await s.forget(it.factKey);
    });
    expect(await t.texts()).toEqual([]);
    expect(await t.memory.rememberText("ticket:PROJ-1", "结论甲")).toBe("written");
    expect(await t.texts()).toHaveLength(1);
  });

  it("returns failed instead of written when the text never becomes visible", async () => {
    const t = setup();
    wrapScopes(() => true, (s) => ({ ...s, remember: async () => ({ superseded: null }) as Awaited<ReturnType<ScopeHandle["remember"]>> }));
    expect(await t.memory.rememberText("ticket:PROJ-1", "看不见")).toBe("failed");
  });

  it("recallText does not wait for the write queue", async () => {
    const t = setup();
    t.addHandoff(payload({ done_today: ["做完了"] }));
    await t.memory.syncTicket("PROJ-1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    wrapScopes(() => true, (s) => ({ ...s, remember: async (x: string) => (await gate, s.remember(x)) }));
    const write = t.memory.rememberText("ticket:PROJ-1", "排着队");
    const got = await Promise.race([t.memory.recallText("ticket:PROJ-1", 1000), new Promise<string>((r) => setTimeout(() => r("TIMEOUT"), 2000))]);
    expect(got).toContain("做完了");
    release();
    expect(await write).toBe("written");
  });

  it("recallText joins the handoff and the notes, capped at maxChars", async () => {
    const t = setup();
    t.addHandoff(payload({ done_today: ["做完了登录页"], decisions: [{ key: "db", statement: "用 PostgreSQL" }] }));
    await t.memory.syncTicket("PROJ-1");
    const all = await t.memory.recallText("ticket:PROJ-1", 10_000);
    expect(all).toContain("做完了登录页");
    expect(all).toContain("用 PostgreSQL");
    expect(all.indexOf("用 PostgreSQL")).toBeLessThan(all.indexOf("做完了登录页"));
    const cut = await t.memory.recallText("ticket:PROJ-1", 40);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(cut).toContain("用 PostgreSQL");
    // 交接很长时，记忆条目也不会被挤出预算
    t.addHandoff(payload({ done_today: ["长".repeat(5000)] }));
    await t.memory.syncTicket("PROJ-1");
    expect(await t.memory.recallText("ticket:PROJ-1", 300)).toContain("用 PostgreSQL");
  });

  it("recallText is empty when memory is off or the read fails", async () => {
    const t = setup();
    t.addHandoff(payload({ done_today: ["x"] }));
    await t.memory.syncTicket("PROJ-1");
    vi.mocked(withScope).mockRejectedValueOnce(new Error("boom"));
    expect(await t.memory.recallText("ticket:PROJ-1", 1000)).toBe("");
    t.setEnabled(false);
    expect(await t.memory.recallText("ticket:PROJ-1", 1000)).toBe("");
  });
});

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
    // 换一个空的数据目录，相当于用户删掉了 ~/.shipherd/statecore。
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

describe("MemoryService notes cap guard (PF2)", () => {
  it("a ticket goes through more than 30 lifetime notes: finished followups free their slots, and nothing churns", async () => {
    const t = setup();
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL 存储会话" }] }));
    t.addFollowup("keep", { description: "上线前通知运维" });
    await t.memory.syncTicket("PROJ-1");
    const pinned = await t.items();
    expect(pinned.map((i) => i.text).sort()).toEqual(["[decision:db] 用 PostgreSQL 存储会话", "[followup:keep] 上线前通知运维（配置，合并后）"]);

    // 40 个 followup 先打开再完成：statecore-mcp 1.1 起 forget 释放位置，每一个都写得进去。
    for (let i = 0; i < 40; i++) {
      t.addFollowup(`tmp_${i}`, { description: distinct(i) });
      await t.memory.syncTicket("PROJ-1");
      const now = await t.items();
      // 一直写下的两条从没被挤掉、也没被重写（factId 不变）。
      for (const p of pinned) expect(now).toContainEqual(p);
      expect(now.some((x) => x.text.startsWith(`[followup:tmp_${i}]`))).toBe(true);
      t.setFollowup(`tmp_${i}`, "done");
      await t.memory.syncTicket("PROJ-1");
      expect(await t.items()).toEqual(pinned);
    }
    expect(await t.slots()).toEqual({ used: 2, cap: NOTES_CAP });

    // 输入不变时第二次同步什么都不写：条目（含 factId、时间）和占用都不变。
    t.addFollowup("late", { description: distinct(99) });
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL 存储会话" }, { key: "cache", statement: "缓存用 Redis" }] }));
    await t.memory.syncTicket("PROJ-1");
    const first = await t.items();
    expect(first).toHaveLength(4);
    for (const p of pinned) expect(first).toContainEqual(p);
    await t.memory.syncTicket("PROJ-1");
    expect(await t.items()).toEqual(first);
    expect(await t.slots()).toEqual({ used: 4, cap: NOTES_CAP });
    const chain = await t.memory.why("PROJ-1", pinned.find((p) => p.text.startsWith("[decision:db]"))!.factId!);
    expect(chain).toHaveLength(1);
    expect(t.logs.some((l) => l.includes("no free note slot"))).toBe(false);
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
    const shipherd = (await t.texts()).filter((x) => x.startsWith("["));
    expect(shipherd).toEqual([`[followup:f_new] ${distinct(101)}（配置，合并后）`]);
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
    const shipherd = (await t.texts()).filter((x) => x.startsWith("[followup:"));
    expect(shipherd.map((x) => /^\[followup:(f_\d)/.exec(x)?.[1]).sort()).toEqual(["f_1", "f_2"]);
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

  it("a note the MCP pushed out and wrote back is registered again, and forgetting it frees its slot (statecore-mcp 1.1)", async () => {
    const t = setup();
    t.addFollowup("f_1", { description: distinct(1) });
    t.addHandoff(payload({ decisions: [{ key: "a", statement: distinct(2) }, { key: "b", statement: distinct(3) }] }));
    await t.memory.syncTicket("PROJ-1");
    const x = `[followup:f_1] ${distinct(1)}（配置，合并后）`;
    const da = `[decision:a] ${distinct(2)}`;
    const db = `[decision:b] ${distinct(3)}`;
    // claude 里的 MCP（不受 Shipherd 的保护）写满并多写一条：挤掉最旧的 f_1；它又一字不差地写回 f_1，挤掉 decision:a。
    await raw(t.dataDir, async (s) => {
      for (let i = 0; i < NOTES_CAP - 2; i++) await s.remember(`Claude 自己记的 ${distinct(10 + i)}`);
      await s.remember(x);
    });
    expect((await t.items()).find((i) => i.text === x)?.factId).not.toBeNull();
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });
    // f_1 完成：Shipherd forget 它，腾出的位置正好把被挤掉的 decision:a 写回去。
    t.setFollowup("f_1", "done");
    await t.memory.syncTicket("PROJ-1");
    const texts = await t.texts();
    expect(texts).toEqual(expect.arrayContaining([da, db]));
    expect(texts.some((x2) => x2.startsWith("[followup:f_1"))).toBe(false);
    expect(await t.slots()).toEqual({ used: NOTES_CAP, cap: NOTES_CAP });
    expect(t.logs.some((l) => l.includes("no free note slot"))).toBe(false);
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
    // Shipherd 写第一条之后，claude 里的 MCP 同时写了一条：位置刚好满了。
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
