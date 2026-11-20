import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONV_LIST_MAX, type ConvListOpts, type ConvMessage, type ConvPage } from "../../shared/conversation";
import type { ConvRepo } from "../db/conv-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import { M } from "../strings";
import { capText } from "./conv-parse";

/**
 * 对话另存（UI 重做第 4 层）对外的读写口：conv:* IPC、换新的恢复提示、第 5 层的分叉讨论都走这里。
 * 传进来的 session id 可以是链上任意一段，一律先转成链根。非分叉的对话只从 transcript 来（ConvIngester），这里不写。
 */

/** 换新的恢复提示里，最近的问答一共最多这么多字。 */
export const RECENT_QA_CHARS = 6000;
/** 单独一轮就超长时，问句最多留这么多字。 */
export const RECENT_QA_QUESTION_CHARS = 800;
const QA_BATCH = 20;

export interface ConversationStoreDeps {
  repo: ConvRepo;
  sessions: Pick<SessionsRepo, "rootOf" | "head" | "chainOf" | "get">;
  onAppended: (rootSessionId: string) => void;
  now: () => number;
}

const cps = (s: string): number => [...s].length;
const headOf = (s: string, n: number): string => (cps(s) <= n ? s : [...s].slice(0, n).join(""));
const tailOf = (s: string, n: number): string => (n <= 0 ? "" : cps(s) <= n ? s : [...s].slice(-n).join(""));

export class ConversationStore {
  constructor(private readonly d: ConversationStoreDeps) {}

  /** 任意一个链上的 id（head、中间段、根）→ 链根；不认识的 id 原样返回。 */
  rootOf(sessionId: string): string {
    return this.d.sessions.rootOf(sessionId) ?? sessionId;
  }

  list(sessionId: string, opts: ConvListOpts): ConvPage {
    const root = this.rootOf(sessionId);
    const limit = Math.min(CONV_LIST_MAX, Math.max(1, Math.floor(Number(opts.limit) || 0)));
    const page = this.d.repo.page(root, { ...opts, limit });
    const marks = this.refreshMarks(root);
    const beforeAt = opts.before !== undefined ? this.d.repo.message(opts.before)?.at : undefined;
    let refreshMarks: ConvPage["refreshMarks"];
    if (page.messages.length === 0) refreshMarks = opts.before !== undefined ? [] : marks;
    else {
      const lower = page.hasMore ? page.messages[0].at : -Infinity;
      const upper = beforeAt ?? Infinity;
      refreshMarks = marks.filter((m) => m.at >= lower && m.at < upper);
    }
    return { messages: page.messages, refreshMarks, hasMore: page.hasMore };
  }

  /** 链上除了根以外的每一段开始的时间（换新、/clear 的位置），按时间升序。 */
  private refreshMarks(root: string): ConvPage["refreshMarks"] {
    const head = this.d.sessions.head(root)?.id;
    if (!head) return [];
    const out: ConvPage["refreshMarks"] = [];
    for (const id of this.d.sessions.chainOf(head)) {
      if (id === root) continue;
      const s = this.d.sessions.get(id);
      if (s) out.push({ at: s.createdAt, sessionId: id });
    }
    return out.sort((a, b) => a.at - b.at || a.sessionId.localeCompare(b.sessionId));
  }

  search(sessionId: string | null, query: string): ConvMessage[] {
    return this.d.repo.search(sessionId === null ? null : this.rootOf(sessionId), query);
  }

  /** 最近的问答（不含分叉），按时间先后拼成 markdown；没有问答返回 ""。总长度不超过 maxChars。 */
  recentQa(rootSessionId: string, maxChars: number): string {
    if (maxChars <= 0) return "";
    const root = this.rootOf(rootSessionId);
    const s = M().refreshTail;
    const c = M().convResume;
    const header = (n: number): string => `# ${c.title}\n\n${c.intro(n)}\n\n`;
    const render = (q: string, a: string): string => `## ${s.user}\n\n${q}\n\n## ${s.assistant}\n\n${a}`;
    const size = (blocks: string[]): number => cps(header(blocks.length)) + cps(blocks.join("\n\n")) + 1;
    const blocks: string[] = []; // 最新的在前
    let before: number | undefined;
    outer: for (;;) {
      const turns = this.d.repo.qaTurns(root, { beforeStartedAt: before, limit: QA_BATCH });
      if (turns.length === 0) break;
      for (const t of turns) {
        before = t.startedAt;
        const msgs = this.d.repo.turnMessages(t.id);
        const q = msgs.filter((m) => m.role === "user").map((m) => m.text).join("\n\n");
        const a = msgs.filter((m) => m.role === "assistant").map((m) => m.text).join("\n\n");
        const block = render(q, a);
        if (size([...blocks, block]) <= maxChars) {
          blocks.push(block);
          continue;
        }
        if (blocks.length === 0) {
          // 最新的一轮自己就放不下：问句截开头，回答留结尾。
          const qq = headOf(q, RECENT_QA_QUESTION_CHARS);
          const room = maxChars - size([render(qq, `${s.cut}\n`)]);
          if (room > 0) blocks.push(render(qq, `${s.cut}\n${tailOf(a, room)}`));
        }
        break outer;
      }
    }
    if (blocks.length === 0) return "";
    return `${header(blocks.length)}${blocks.reverse().join("\n\n")}\n`;
  }

  /**
   * 第 5 层写分叉讨论的一条消息。forkId 必须非空；rootSessionId 先转成链根；text 过 capText；msg.turnId 和 msg.qa 不用。
   * user 开一轮 fork（qa=no、qa_by=fork）；assistant 挂在这个分叉最新的那一轮上，没有就先开一轮。写完调 onAppended(链根)。
   */
  append(msg: Omit<ConvMessage, "id">): ConvMessage {
    const forkId = msg.forkId;
    if (forkId === null) throw new Error("ConversationStore.append only takes fork messages; the main conversation comes from the transcript");
    const root = this.rootOf(msg.rootSessionId);
    const { repo } = this.d;
    const saved = repo.transaction(() => {
      const open = (): number => {
        const id = repo.openTurn({ rootSessionId: root, sessionId: msg.sessionId, sourceKey: null, forkId, kind: "fork", at: msg.at, asked: false });
        repo.setQa(id, "no", "fork");
        return id;
      };
      const turnId = msg.role === "user" ? open() : (repo.latestForkTurn(root, forkId)?.id ?? open());
      repo.touchTurn(turnId, { at: msg.at });
      const m = repo.addMessage({ turnId, rootSessionId: root, sessionId: msg.sessionId, role: msg.role, text: capText(msg.text), at: msg.at, forkId, sourceKey: null });
      if (!m) throw new Error("fork message was not stored");
      return m;
    });
    this.d.onAppended(root);
    return saved;
  }

  /** 这个分叉的全部消息，按时间升序；没有返回 []。 */
  byFork(forkId: number): ConvMessage[] {
    return this.d.repo.forkMessages(forkId);
  }
}

/** 换新的恢复文件：tail 写成了就在后面追加问答；tail 没写成但有问答，就只写问答。返回最终的文件路径，什么都没写返回 null。 */
export async function withRecentQa(out: string, tailPath: string | null, qa: string): Promise<string | null> {
  if (!qa) return tailPath;
  if (tailPath !== null) {
    await appendFile(tailPath, `\n${qa}`);
    return tailPath;
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, qa);
  return out;
}
