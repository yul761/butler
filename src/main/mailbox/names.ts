// 信箱（BTL-245）里给人看的 session 名字：列表的「谁发给谁」、回复和约定的开头。
import type { Session } from "../../shared/types";
import { M } from "../strings";

export interface NameDeps {
  head(sessionId: string): Session | null;
  featureName(featureId: number): string | null;
  epicName(epicId: number): string | null;
}

/** "ABC-1"、"feature 登录改版的总控"、"feature 登录改版的修复 session"、"Butler 总控"；null 是 Butler 自己。认不出来的给 id。 */
export function sessionName(d: NameDeps, id: string | null): string {
  const m = M();
  if (id === null) return m.mailboxButlerSelf;
  const h = d.head(id);
  if (!h) return id;
  if (h.ticketKey !== null) return h.ticketKey;
  if (h.featureId !== null) {
    const name = d.featureName(h.featureId) ?? String(h.featureId);
    return h.fixesSession !== null ? m.mailboxFixName(name) : m.butlerTargetFeature(name);
  }
  if (h.epicId !== null) return m.butlerTargetEpic(d.epicName(h.epicId) ?? String(h.epicId));
  if (h.butler) return m.mailboxButlerName;
  return id;
}
