// 「谁该动」看板上的总控 session（UI 重做第 1 层）：feature 总控和 Shipherd 总控的 head，各带页面 target。
import type { NowTarget, Session } from "../../shared/types";

export interface TurnCoordinator {
  session: Session;
  featureId: number | null;
  target: NowTarget;
  title: string | null;
}

type Live = Session & { termId?: string | null };

export interface TurnCoordinatorDeps {
  featureViews(): { id: number; name: string; sessions: Live[] }[];
  /** 开着终端的 Shipherd 总控 head（数据库里的 Session，不带 termId）。 */
  runningShipherd(): Session | null;
  hibernatedHeads(): Session[];
}

/** 开着终端、休眠着或唤醒失败的 head 才算活着（和 now-view 一样）。 */
const alive = (s: Live): boolean => (!!s.termId || !!s.hibernatedAt || !!s.wakeError) && s.replacedBy === null;

export function turnCoordinators(d: TurnCoordinatorDeps): TurnCoordinator[] {
  const hib = d.hibernatedHeads();
  const out: TurnCoordinator[] = [];
  const seen = new Set<string>();
  const push = (session: Live, featureId: number | null, target: NowTarget, title: string | null, open = false) => {
    if (seen.has(session.id) || !(open || alive(session))) return;
    seen.add(session.id);
    out.push({ session, featureId, target, title });
  };
  for (const f of d.featureViews()) {
    const own = [...f.sessions, ...hib.filter((h) => h.featureId === f.id && h.ticketKey === null)];
    for (const x of own) if (x.fixesSession === null) push(x, f.id, { page: "feature", id: f.id, sessionId: x.id }, f.name);
  }
  // runningShipherd 只从开着的终端里取，本身就活着；它是数据库行、没有 termId，不能再过 alive。
  const running = d.runningShipherd();
  const b = running ?? hib.find((h) => h.shipherd && h.ticketKey === null) ?? null;
  if (b) push(b, null, { page: "shipherd", sessionId: b.id }, null, running !== null);
  return out;
}
