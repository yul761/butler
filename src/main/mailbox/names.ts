// 信箱（BTL-245）里给人看的 session 名字：列表的「谁发给谁」、回复和约定的开头。
import type { Session } from "../../shared/types";
import { M } from "../strings";

export interface NameDeps {
  head(sessionId: string): Session | null;
  featureName(featureId: number): string | null;
}

/** "ABC-1"、"epic 登录改版 的总控"、"epic 登录改版 的修复 session"、"全局总控"；null 是 Shipherd 自己。认不出来的给 id。 */
export function sessionName(d: NameDeps, id: string | null): string {
  const m = M();
  if (id === null) return m.mailboxShipherdSelf;
  const h = d.head(id);
  if (!h) return id;
  if (h.ticketKey !== null) return h.ticketKey;
  // featureId 是 epic（内部是 features 表，BTL-246）。
  if (h.featureId !== null) {
    const name = d.featureName(h.featureId) ?? String(h.featureId);
    return h.fixesSession !== null ? m.mailboxFixName(name) : m.shipherdTargetFeature(name);
  }
  if (h.shipherd) return m.mailboxShipherdName;
  return id;
}
