import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEmbeddedBackend } from "statecore-mcp/lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ticketScope, WORKSPACE_SCOPE } from "../../shared/memory";
import { tempDir } from "../test-utils";
import { listScopeNames, parseDigestOutcome, withScope } from "./statecore";

// StateCore 的 pino 直接读 process.env.LOG_LEVEL（不看 env 选项），在它加载之前静音。
vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

/** 直接用 StateCore 写一条 consolidate 事件（模拟 claude 里的 remember(consolidate: true)）。 */
async function seedEvent(dataDir: string, scope: string, text: string): Promise<void> {
  const b = createEmbeddedBackend({ dataDir, scopeName: scope, env: {}, backgroundDigest: false });
  await b.init();
  try {
    await b.remember({ text, consolidate: true });
  } finally {
    await b.close();
  }
}

describe("StateCore adapter (design 8, 11: write and why integration)", () => {
  it("remembers, lists and forgets notes, and keeps scopes apart", async () => {
    const dir = tempDir();
    await withScope({ dataDir: dir, scope: ticketScope("PROJ-1") }, async (s) => {
      expect(await s.remember("[decision:db] 用 PostgreSQL")).toEqual({ superseded: null });
      await s.remember("[followup:f_1] 改 staging 配置（配置，合并后）");
      const items = await s.facts();
      expect(items.map((i) => i.text)).toEqual(["[decision:db] 用 PostgreSQL", "[followup:f_1] 改 staging 配置（配置，合并后）"]);
      expect(items.every((i) => i.group === "Notes" && i.factKey.length === 16 && i.factId !== null && i.createdAt !== null)).toBe(true);
      await s.forget(items[0].factKey);
      expect((await s.facts()).map((i) => i.text)).toEqual(["[followup:f_1] 改 staging 配置（配置，合并后）"]);
    });
    await withScope({ dataDir: dir, scope: WORKSPACE_SCOPE }, async (s) => {
      expect(await s.facts()).toEqual([]);
    });
    expect((await listScopeNames(dir)).sort()).toEqual(["ticket:PROJ-1", "workspace"]);
  });

  it("forget then remember a revision keeps the old version on the why chain", async () => {
    const dir = tempDir();
    await withScope({ dataDir: dir, scope: "ticket:PROJ-2" }, async (s) => {
      await s.remember("[decision:db] 用 PostgreSQL 存储会话");
      const [old] = await s.facts();
      await s.forget(old.factKey);
      expect(await s.remember("[decision:db] 用 MySQL 存储会话")).toEqual({ superseded: "[decision:db] 用 PostgreSQL 存储会话" });
      const [cur] = await s.facts();
      const chain = await s.why(cur.factId!);
      expect(chain?.map((e) => e.content)).toEqual(["[decision:db] 用 PostgreSQL 存储会话", "[decision:db] 用 MySQL 存储会话"]);
      expect(chain?.[0].supersededBy).toBe(cur.factId);
      expect(chain?.[1]).toMatchObject({ supersededBy: null, retiredAt: null });
      expect(await s.why("no-such-id")).toBeNull();
    });
  });

  it("a text identical to a forgotten note stays hidden; a variant prefix shows it (design 13.1)", async () => {
    await withScope({ dataDir: tempDir(), scope: "ticket:PROJ-3" }, async (s) => {
      await s.remember("[followup:f_9] 部署后打开开关");
      const [item] = await s.facts();
      await s.forget(item.factKey);
      await s.remember("[followup:f_9] 部署后打开开关");
      expect(await s.facts()).toEqual([]);
      await s.remember("[followup:f_9#2] 部署后打开开关");
      expect((await s.facts()).map((i) => i.text)).toEqual(["[followup:f_9#2] 部署后打开开关"]);
    });
  });

  it("takes a note that differs from another only in its id for a revision of it (why variants carry distinguishing words)", async () => {
    await withScope({ dataDir: tempDir(), scope: "ticket:PROJ-9" }, async (s) => {
      await s.remember("[followup:f_3] 描述 f_3（配置，合并后）");
      expect(await s.remember("[followup:f_4] 描述 f_4（配置，合并后）")).toEqual({ superseded: "[followup:f_3] 描述 f_3（配置，合并后）" });
      expect((await s.facts()).map((i) => i.text)).toEqual(["[followup:f_4] 描述 f_4（配置，合并后）"]);
    });
  });

  it("stores a handoff that supersedes the previous one and walks its chain", async () => {
    await withScope({ dataDir: tempDir(), scope: "ticket:PROJ-4" }, async (s) => {
      expect(await s.activeHandoff()).toBeNull();
      await s.handoff({ summary: "状态：active。", nextSteps: ["写测试"], openQuestions: [] });
      await s.handoff({ summary: "状态：in_review。完成：写测试", nextSteps: ["等 review"], openQuestions: ["要不要拆 PR？"] });
      const h = await s.activeHandoff();
      expect(h).toMatchObject({ versionCount: 2 });
      expect(h?.content).toBe("状态：in_review。完成：写测试\nOpen questions:\n- 要不要拆 PR？\nNext steps:\n- 等 review");
      expect((await s.why(h!.id))?.map((e) => e.content.split("\n")[0])).toEqual(["状态：active。", "状态：in_review。完成：写测试"]);
    });
  });

  it("reports pending consolidate events and cannot digest without a model", async () => {
    const dir = tempDir();
    await seedEvent(dir, "ticket:PROJ-5", "claude 里记下的一段原始对话");
    await withScope({ dataDir: dir, scope: "ticket:PROJ-5" }, async (s) => {
      expect(await s.pendingEvents()).toBe(1);
      expect(await s.digestNow()).toBe("no-llm");
    });
  });

  it("never hands StateCore a model key from the environment (R1)", async () => {
    const dir = tempDir();
    await seedEvent(dir, "ticket:PROJ-6", "原始事件");
    process.env.FEATURE_LLM = "true";
    process.env.MODEL_API_KEY = "sk-inherited";
    process.env.OPENAI_API_KEY = "sk-inherited-2";
    // A regression must never be able to reach a real provider.
    process.env.MODEL_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
    await withScope({ dataDir: dir, scope: "ticket:PROJ-6" }, async (s) => {
      expect(await s.digestNow()).toBe("no-llm");
    });
  });

  it("digests through an injected model only", async () => {
    const dir = tempDir();
    await seedEvent(dir, "ticket:PROJ-7", "原始事件");
    const seen: string[] = [];
    const model = {
      chat: async (messages: { role: "system" | "user"; content: string }[]) => {
        seen.push(messages.map((m) => m.role).join(","));
        throw new Error("stub model");
      },
    };
    await withScope({ dataDir: dir, scope: "ticket:PROJ-7", model }, async (s) => {
      expect(await s.digestNow()).toBe("failed");
      expect(await s.pendingEvents()).toBe(1);
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("validates digestNow results and maps anything unknown to unsupported", () => {
    expect(parseDigestOutcome({ ran: true })).toBe("ran");
    expect(parseDigestOutcome({ ran: false, reason: "locked" })).toBe("locked");
    expect(parseDigestOutcome({ ran: false, reason: "something-new" })).toBe("unsupported");
    expect(parseDigestOutcome({ ran: false })).toBe("unsupported");
    expect(parseDigestOutcome(null)).toBe("unsupported");
  });

  it("lists no scopes and creates nothing when the store does not exist", async () => {
    const dir = tempDir();
    expect(await listScopeNames(dir)).toEqual([]);
    expect(existsSync(join(dir, "statecore.db"))).toBe(false);
  });

  it("closes the store even when the callback throws", async () => {
    const dir = tempDir();
    await expect(withScope({ dataDir: dir, scope: "ticket:PROJ-8" }, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    // 关掉了才能再次打开并写入。
    await withScope({ dataDir: dir, scope: "ticket:PROJ-8" }, async (s) => {
      await s.remember("[decision:x] ok");
      expect(await s.facts()).toHaveLength(1);
    });
  });
});
