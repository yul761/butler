import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEmbeddedBackend, listScopes } from "statecore-mcp/lib";
import { z } from "zod";
import type { MemoryHandoff, MemoryItem, WhyEntry } from "../../shared/memory";
import { statecoreEnv } from "../gateway/statecore-env";
import type { StatecoreChatModel } from "../gateway/types";

/**
 * Butler 里唯一 import statecore-mcp/lib 的生产代码（ESLint 强制，计划 4 R1）。
 * 每次操作都是“打开 → 做事 → 关闭”：同一个 statecore.db 还会被 claude 里挂的 MCP 进程同时打开（WAL + busy timeout），
 * 主进程不长期占着连接。StateCore 的返回值类型是 unknown，这里用 zod 校验成 Butler 自己的类型。
 */

export type DigestOutcome = "ran" | "no-llm" | "below-threshold" | "locked" | "failed" | "unsupported";

/**
 * StateCore 1.0.0 每个 scope 的 notes 上限（默认 facet pack 里 notes 的 cap）。满了再追加一条，StateCore 挤掉最旧的那条。
 * forget 只是把条目藏起来：原文还在 notes 里占着位置（lib 不导出清理函数）。蒸馏也不释放：StateCore 1.0.0 的蒸馏会把它们从 notes 里删掉，
 * 但写快照时 carryOverConcurrentNotes 按事实登记又把它们加回 notes 末尾（任务 6 实测），所以被 forget 的条目一直占着位置。
 */
export const NOTES_CAP = 30;

export interface ScopeHandle {
  /** 确定性地写一条 note（不经 LLM）。superseded：被它取代的旧 note 的原文。 */
  remember(text: string): Promise<{ superseded: string | null }>;
  forget(factKey: string): Promise<void>;
  facts(): Promise<MemoryItem[]>;
  /** 一条事实（或交接）从最早到最新的版本；id 不存在时为 null。 */
  why(factId: string): Promise<WhyEntry[] | null>;
  /**
   * 记一次交接（设计文档 8.3：每次 handoff 都写一个版本）。返回是否写了。
   * 给了 retryAfter（这次交接在 Butler 里的 createdAt，毫秒）时：当前生效的交接一字不差、并且是在 retryAfter 当时或之后写的，
   * 说明它就是同一次同步上一次没做完时写进去的，这次不再写，重试不会给 why 链多加一个一样的版本。
   * 内容一样、但写在这次交接之前的（另一次 handoff 正好内容相同）照常写。
   */
  handoff(h: { summary: string; nextSteps: string[]; openQuestions: string[] }, retryAfter?: number): Promise<boolean>;
  activeHandoff(): Promise<MemoryHandoff | null>;
  /**
   * 这个 scope 的 notes 占了几个位置：看得见的加上 forget 过、但还占着位置的。
   * 数的是 StateCore 的有效事实登记（recall 的 factRegistry 里 facet 为 notes、没被取代也没退役的条目），
   * 再并上 facts() 里看得见的 Notes（防止个别条目没登记），按 StateCore 的规则（去首尾空白、压空白、小写）去重。
   */
  noteSlots(): Promise<{ used: number; cap: number }>;
  /** 等待蒸馏的 consolidate 事件数。 */
  pendingEvents(): Promise<number>;
  /** 立即蒸馏一次（只有 withScope 给了 model 才可能 ran）。 */
  digestNow(): Promise<DigestOutcome>;
}

const FactGroups = z.array(
  z.object({
    group: z.string(),
    items: z.array(z.object({ factKey: z.string(), text: z.string(), createdAt: z.string().nullable(), factId: z.string().nullable() })),
  }),
);
const RegistryEntry = z.object({
  id: z.string(),
  content: z.string(),
  addedAt: z.string(),
  supersededBy: z.string().optional(),
  retiredAt: z.string().optional(),
  retiredReason: z.string().optional(),
});
const WhyResult = z.object({ chain: z.array(RegistryEntry) }).nullable();
const RecallResult = z.object({
  handoff: z.object({ id: z.string(), content: z.string(), addedAt: z.string(), versionCount: z.number() }).nullable(),
});
const Registry = z.object({ factRegistry: z.array(z.object({ content: z.string(), facet: z.string().optional() })) });
const Remembered = z.object({ superseded: z.string().optional() });
const DigestResult = z.union([
  z.object({ ran: z.literal(true) }),
  z.object({ ran: z.literal(false), reason: z.enum(["no-llm", "below-threshold", "locked", "failed", "unsupported"]) }),
]);
const Pending = z.object({ events: z.number() }).nullable().optional();

type Backend = ReturnType<typeof createEmbeddedBackend>;

/** StateCore 比较 notes 是否相同的规则（addNoteFact 里的 norm）。 */
const noteNorm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
/** StateCore 默认 facet pack 里 notes 的展示分组。 */
const NOTES_GROUP = "Notes";

/** StateCore 1.0.0 存交接时的正文格式（formatHandoff）。 */
function handoffContent(h: { summary: string; nextSteps: string[]; openQuestions: string[] }): string {
  const lines = [h.summary.trim()];
  const section = (title: string, items: string[]) => {
    const kept = items.map((x) => x.trim()).filter(Boolean);
    if (kept.length) lines.push(title, ...kept.map((x) => `- ${x}`));
  };
  section("Open questions:", h.openQuestions);
  section("Next steps:", h.nextSteps);
  return lines.join("\n");
}

function handle(b: Backend): ScopeHandle {
  const facts = async (): Promise<MemoryItem[]> =>
    FactGroups.parse(await b.facts()).flatMap((g) =>
      g.items.map((i) => ({ factKey: i.factKey, factId: i.factId, text: i.text, createdAt: i.createdAt, group: g.group })),
    );
  return {
    async remember(text) {
      const r = Remembered.parse(await b.remember({ text }));
      return { superseded: r.superseded ?? null };
    },
    async forget(factKey) {
      await b.forget({ factKey });
    },
    facts,
    async why(factId) {
      const r = WhyResult.parse(await b.why({ factId }));
      return r
        ? r.chain.map((e) => ({
            id: e.id,
            content: e.content,
            addedAt: e.addedAt,
            supersededBy: e.supersededBy ?? null,
            retiredAt: e.retiredAt ?? null,
            retiredReason: e.retiredReason ?? null,
          }))
        : null;
    },
    async handoff(h, retryAfter) {
      if (retryAfter !== undefined) {
        const active = RecallResult.parse(await b.recall({})).handoff;
        if (active && active.content === handoffContent(h) && Date.parse(active.addedAt) >= retryAfter) return false;
      }
      await b.handoff({ summary: h.summary, nextSteps: h.nextSteps, openQuestions: h.openQuestions });
      return true;
    },
    async activeHandoff() {
      return RecallResult.parse(await b.recall({})).handoff;
    },
    async noteSlots() {
      const notes = new Set(
        Registry.parse(await b.recall({}))
          .factRegistry.filter((e) => e.facet === "notes")
          .map((e) => noteNorm(e.content)),
      );
      for (const i of await facts()) if (i.group === NOTES_GROUP) notes.add(noteNorm(i.text));
      return { used: notes.size, cap: NOTES_CAP };
    },
    async pendingEvents() {
      return Pending.parse(await b.pendingEvents?.())?.events ?? 0;
    },
    async digestNow() {
      return parseDigestOutcome(await b.digestNow());
    },
  };
}

/** 校验 StateCore digestNow() 的结果；形状或 reason 不认识时按 "unsupported" 处理，不让未知值流出去。 */
export function parseDigestOutcome(raw: unknown): DigestOutcome {
  const r = DigestResult.safeParse(raw);
  if (!r.success) return "unsupported";
  return r.data.ran ? "ran" : r.data.reason;
}

/**
 * 打开一个 scope，执行 fn，然后一定关闭。环境变量一律经 statecoreEnv() 去掉模型相关的变量（R1）；
 * 后台蒸馏关闭（backgroundDigest: false：Butler 的写入是确定性的，不触发任何 LLM 调用）。
 * 只有给了 model（PrivacyGateway.statecoreModel() 的结果）时 digestNow() 才可能调用模型。
 */
export async function withScope<T>(
  o: { dataDir: string; scope: string; model?: StatecoreChatModel | null },
  fn: (s: ScopeHandle) => Promise<T>,
): Promise<T> {
  const backend = createEmbeddedBackend({
    dataDir: o.dataDir,
    scopeName: o.scope,
    env: statecoreEnv(process.env),
    backgroundDigest: false,
    ...(o.model ? { digestLlm: o.model } : {}),
  });
  try {
    await backend.init();
    return await fn(handle(backend));
  } finally {
    await backend.close();
  }
}

/** 存储里所有 scope 的名字；存储还不存在时返回空，不会创建它。 */
export async function listScopeNames(dataDir: string): Promise<string[]> {
  if (!existsSync(join(dataDir, "statecore.db"))) return [];
  return (await listScopes(dataDir)).map((s) => s.name);
}
