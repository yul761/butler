import type { ConvRepo, TurnKind } from "../db/conv-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import { capText, convEntriesOf, type ConvEntry, type UserOpen } from "./conv-parse";
import { isQuestionLike } from "./conv-qa";
import { readChunk } from "./jsonl-reader";

/**
 * 对话另存（UI 重做第 4 层）：把 transcript 增量读进 conv_* 表。只存双方说的话；工具调用只用来给这一轮打标记。
 * 游标（字节位置、inode、打开的那一轮）存在库里，重启以后接着读；同一行重读靠 source_key 去重。
 */

/** 每个 session 记住最近这么多个 entry 属于哪一轮（只在内存里；重启以后靠游标里的 openTurnId 接上）。 */
export const PARENT_MAP_MAX = 2000;

export interface ConvIngesterDeps {
  repo: ConvRepo;
  sessions: Pick<SessionsRepo, "rootOf" | "head" | "chainOf" | "get" | "listConvTargets">;
  transcriptOf: (sessionId: string) => string | null;
  onAppended: (rootSessionId: string) => void;
  now: () => number;
  chunkBytes?: number;
  maxLineBytes?: number;
  log?: (msg: string) => void;
}

const KIND_OF: Record<UserOpen, TurnKind> = { user: "user", relay: "silent", silent: "silent", handoff: "handoff" };

export class ConvIngester {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly parents = new Map<string, Map<string, number>>();

  constructor(private readonly d: ConvIngesterDeps) {}

  /** 把这个 session 的 transcript 读到最新（同一个 session 串行：前一次没完就排在它后面）。出错只记日志。 */
  ingest(sessionId: string): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.run(sessionId));
    this.chains.set(sessionId, next);
    void next.then(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
    return next;
  }

  private async run(id: string): Promise<void> {
    const touched = new Set<string>();
    try {
      await this.readAll(id, touched);
    } catch (e) {
      this.parents.delete(id);
      this.d.log?.(`conv ingest ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const root of touched) {
      try {
        this.d.onAppended(root);
      } catch (e) {
        this.d.log?.(`conv onAppended ${root}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async readAll(id: string, touched: Set<string>): Promise<void> {
    const { repo } = this.d;
    const file = this.d.transcriptOf(id);
    if (!file) return;
    const root = this.d.sessions.rootOf(id) ?? id;
    let cursor = repo.cursor(id);
    if (cursor && cursor.rootSessionId !== root) {
      // 先读到、后连上 replaced_by：整段搬到链根下。
      repo.reroot(id, root);
      touched.add(root);
      cursor = repo.cursor(id);
    }
    let openTurnId = cursor?.openTurnId ?? null;
    let from = { ino: cursor?.ino ?? null, offset: cursor?.offset ?? 0 };
    for (;;) {
      const chunk = await readChunk(file, from, { chunkBytes: this.d.chunkBytes, maxLineBytes: this.d.maxLineBytes });
      if (!chunk) return;
      if (chunk.skipped > 0) this.d.log?.(`conv ingest ${id}: skipped ${chunk.skipped} line(s) over the size limit at byte ${chunk.start}`);
      if (chunk.lines.length === 0 && chunk.skipped === 0) return;
      let changed = false;
      try {
        repo.transaction(() => {
          for (const line of chunk.lines) {
            for (const e of convEntriesOf(line)) {
              const r = this.apply(id, root, e, openTurnId);
              openTurnId = r.openTurnId;
              changed ||= r.changed;
            }
          }
          repo.saveCursor({ sessionId: id, rootSessionId: root, file, ino: chunk.ino, offset: chunk.next, openTurnId, updatedAt: this.d.now() });
        });
      } catch (e) {
        // 事务回滚了：parentMap 里可能有指向回滚掉的轮的 id。
        this.parents.delete(id);
        throw e;
      }
      if (changed) touched.add(root);
      from = { ino: chunk.ino, offset: chunk.next };
    }
  }

  private parentMap(id: string): Map<string, number> {
    let m = this.parents.get(id);
    if (!m) {
      m = new Map();
      this.parents.set(id, m);
    }
    return m;
  }

  private remember(id: string, key: string, turnId: number): void {
    const m = this.parentMap(id);
    m.set(key, turnId);
    while (m.size > PARENT_MAP_MAX) {
      const first = m.keys().next();
      if (first.done) break;
      m.delete(first.value);
    }
  }

  /** 处理一个 entry；返回新的打开的那一轮，以及有没有新写消息或改了问答结论。 */
  private apply(id: string, root: string, e: ConvEntry, openTurnId: number | null): { openTurnId: number | null; changed: boolean } {
    const { repo } = this.d;
    const parents = this.parentMap(id);
    const timeOf = (turnId: number | null): number => e.at ?? (turnId !== null ? repo.turn(turnId)?.lastAt : undefined) ?? this.d.now();
    let changed = false;
    const add = (turnId: number, role: "user" | "assistant", text: string, at: number): void => {
      const m = repo.addMessage({ turnId, rootSessionId: root, sessionId: id, role, text: capText(text), at, forkId: null, sourceKey: e.key });
      if (m) changed = true;
    };

    if (e.kind === "user") {
      const at = timeOf(openTurnId);
      if (openTurnId !== null) repo.touchTurn(openTurnId, { at, endedAt: at });
      const kind = KIND_OF[e.open];
      const turnId = repo.openTurn({
        rootSessionId: root, sessionId: id, sourceKey: e.key, forkId: null, kind, at,
        asked: e.open === "user" && isQuestionLike(e.text ?? ""),
      });
      if (kind !== "user") changed = repo.setQa(turnId, "no", "rule") || changed;
      if ((e.open === "user" || e.open === "relay") && e.text) add(turnId, "user", e.text, at);
      this.remember(id, e.key, turnId);
      return { openTurnId: turnId, changed };
    }

    let turnId = (e.parent !== null ? parents.get(e.parent) : undefined) ?? openTurnId;
    if (e.kind === "noise") {
      if (turnId !== null) this.remember(id, e.key, turnId);
      return { openTurnId, changed };
    }
    if (turnId === null) {
      // 前面没有用户的话（文件中间开始、或者只有 agent 在说）：开一轮 orphan，不算问答。
      turnId = repo.openTurn({ rootSessionId: root, sessionId: id, sourceKey: `orphan:${e.key}`, forkId: null, kind: "orphan", at: timeOf(null), asked: false });
      repo.setQa(turnId, "no", "rule");
      openTurnId = turnId;
    }
    const at = timeOf(turnId);
    const turn = repo.turn(turnId);
    if (e.kind === "assistant") {
      if (turn && turn.kind !== "handoff" && e.text) add(turnId, "assistant", e.text, at);
      repo.touchTurn(turnId, { at, ...(e.stop && { endedAt: at }) });
    } else {
      const mutated = e.effect === "mutate";
      repo.touchTurn(turnId, { at, mutated, otherTools: e.effect === "other", ...(e.stop && { endedAt: at }) });
      if (mutated && turn?.qa === "yes") changed = repo.setQa(turnId, "no", "rule") || changed;
    }
    this.remember(id, e.key, turnId);
    return { openTurnId, changed };
  }
}
