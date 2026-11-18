import type { HibernateReason, SessionView } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";

/** 休眠着（WS-M B）：终端是 Butler 为了省内存结束的，点开就 --resume。 */
export const isHibernated = (s: SessionView): boolean => s.termId === null && !!s.hibernatedAt;

/** 这个终端（session id）休眠的原因；没休眠是 null。终端横幅按它选文案。 */
export function hibernationOf(sessions: SessionView[], id: string): HibernateReason | null {
  const s = sessions.find((x) => x.id === id);
  return s && isHibernated(s) ? (s.hibernateReason ?? "idle") : null;
}

/** 能休眠、能钉住的 session（和主进程 hibernatableKind 一样）：Butler 开的，不是修复 session、不是复盘分析。 */
export const pinnable = (s: SessionView): boolean => s.origin === "butler" && s.fixesSession === null && s.lessonRunId === null;

/** session 按钮的提示：第一条消息、id，休眠着的说为什么，上次唤醒失败的说失败原因。 */
export function sessionTitle(s: SessionView): string {
  return [
    s.firstPrompt ?? S.untitledSession,
    s.id,
    isHibernated(s) ? `${S.hib.badge}: ${S.hib.reason[s.hibernateReason ?? "idle"]}` : null,
    s.wakeError ? S.hib.wakeFailed(s.wakeError) : null,
  ].filter(Boolean).join("\n");
}

/** session 按钮里的「休眠」和唤醒失败的标记。 */
export function HibernateBadges({ s }: { s: SessionView }) {
  return (
    <>
      {isHibernated(s) && <small className="hib-badge">{S.hib.badge}</small>}
      {s.wakeError && <small className="wake-error" aria-label={S.hib.wakeFailed(s.wakeError)}>!</small>}
    </>
  );
}

/** 钉住开关：开着或者休眠着、能休眠的 session 才有。 */
export function PinButton({ s, label }: { s: SessionView; label: string }) {
  if (!pinnable(s) || (s.termId === null && !isHibernated(s))) return null;
  const on = !!s.pinned;
  return (
    <button
      className={on ? "session-pin on" : "session-pin"}
      title={`${on ? S.hib.unpin : S.hib.pin}: ${S.hib.pinHint}`}
      aria-label={on ? S.hib.unpinNamed(label) : S.hib.pinNamed(label)}
      aria-pressed={on}
      onClick={() => api.pinSession(s.id, !on).catch(reportError)}
    >
      📌
    </button>
  );
}
