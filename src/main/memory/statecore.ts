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

export interface ScopeHandle {
  /** 确定性地写一条 note（不经 LLM）。superseded：被它取代的旧 note 的原文。 */
  remember(text: string): Promise<{ superseded: string | null }>;
  forget(factKey: string): Promise<void>;
  facts(): Promise<MemoryItem[]>;
  /** 一条事实（或交接）从最早到最新的版本；id 不存在时为 null。 */
  why(factId: string): Promise<WhyEntry[] | null>;
  handoff(h: { summary: string; nextSteps: string[]; openQuestions: string[] }): Promise<void>;
  activeHandoff(): Promise<MemoryHandoff | null>;
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
const Remembered = z.object({ superseded: z.string().optional() });
const Pending = z.object({ events: z.number() }).nullable().optional();

type Backend = ReturnType<typeof createEmbeddedBackend>;

function handle(b: Backend): ScopeHandle {
  return {
    async remember(text) {
      const r = Remembered.parse(await b.remember({ text }));
      return { superseded: r.superseded ?? null };
    },
    async forget(factKey) {
      await b.forget({ factKey });
    },
    async facts() {
      return FactGroups.parse(await b.facts()).flatMap((g) =>
        g.items.map((i) => ({ factKey: i.factKey, factId: i.factId, text: i.text, createdAt: i.createdAt, group: g.group })),
      );
    },
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
    async handoff(h) {
      await b.handoff({ summary: h.summary, nextSteps: h.nextSteps, openQuestions: h.openQuestions });
    },
    async activeHandoff() {
      return RecallResult.parse(await b.recall({})).handoff;
    },
    async pendingEvents() {
      return Pending.parse(await b.pendingEvents?.())?.events ?? 0;
    },
    async digestNow() {
      const r = await b.digestNow();
      return r.ran ? "ran" : r.reason;
    },
  };
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
