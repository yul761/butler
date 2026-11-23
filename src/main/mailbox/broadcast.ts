// 约定广播（BTL-245 设计第 7 节）：一个 session 往 feature 记忆里 remember 了一条约定，
// 推给同一个 feature 里终端开着的其他 session（作者自己不推）。consolidate: true 存的长对话上下文不是约定，不推。
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { Session } from "../../shared/types";
import { REMEMBER_TOOL } from "../claude/project-mcp";
import { M } from "../strings";
import type { SendInput } from "./mailbox";

export interface BroadcastDeps {
  head(sessionId: string): Session | null;
  /** ticket 属于哪个 feature；不属于任何 feature 为 null。 */
  ticketFeature(ticketKey: string): number | null;
  /** 现在开着的终端。 */
  openTerms(): string[];
  nameOf(sessionId: string): string;
  send(input: SendInput): unknown;
}

/** 信封是一次存进 feature 记忆的约定：作者（终端或 session id）和内容；不是为 null。 */
export function conventionFromEnvelope(env: HookEnvelope): { author: string; text: string } | null {
  if (isHeadlessEnvelope(env)) return null;
  const p = env.payload && typeof env.payload === "object" ? (env.payload as Record<string, unknown>) : null;
  if (!p || p.hook_event_name !== "PostToolUse" || p.tool_name !== REMEMBER_TOOL) return null;
  const input = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
  if (input.consolidate === true || typeof input.text !== "string" || !input.text.trim()) return null;
  const author = env.shipherdSession ?? (typeof p.session_id === "string" ? p.session_id : null);
  return author ? { author, text: input.text.trim() } : null;
}

/** 这个 session 属于哪个 feature：ticket session 看 ticket 的，总控和修复 session 看自己的 featureId。 */
function featureOf(d: BroadcastDeps, s: Session): number | null {
  return s.ticketKey !== null ? d.ticketFeature(s.ticketKey) : s.featureId;
}

/** 推给同一个 feature 里开着的其他 session，返回推了几个。 */
export function broadcastConvention(d: BroadcastDeps, env: HookEnvelope): number {
  const c = conventionFromEnvelope(env);
  if (!c) return 0;
  const author = d.head(c.author);
  if (!author) return 0;
  const featureId = featureOf(d, author);
  if (featureId === null) return 0;
  const body = M().mailboxConvention(d.nameOf(author.id), c.text);
  const seen = new Set<string>([author.id]);
  let n = 0;
  for (const term of d.openTerms()) {
    const h = d.head(term);
    if (!h || seen.has(h.id) || featureOf(d, h) !== featureId) continue;
    seen.add(h.id);
    d.send({ kind: "convention", from: author.id, to: h.id, featureId, body });
    n++;
  }
  return n;
}
