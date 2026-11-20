// Butler 要你点一下的那条提醒（从「现在」页原样搬出，UI 重做第 2 层）：一句话加原来的按钮。testid 保持 now-notice-*。
import { useState } from "react";
import type { NowNotice, NowTarget } from "../../../shared/types";
import { api } from "../api";
import { ciReasonText, noticeText, type NoticeAction } from "../availability-view";
import { btError } from "../backtest-view";
import { costAmount } from "../cost-view";
import { reportError } from "../errors";
import { intakeActError } from "../intake-view";
import { saveTab, saveTabOpen } from "../local-prefs";
import { S } from "../strings";
import type { Route } from "../App";
import { noticeKey } from "../home-view";

export { noticeKey };

/** 顶上的一条提醒：一句话加几个按钮；恢复、重试都是让复盘队列重新开始。 */
export function Notice({ notice: n, now, onOpen, onGo }: { notice: NowNotice; now: number; onOpen: (t: NowTarget) => void; onGo: (r: Route) => void }) {
  const { text, actions } = noticeText(n, S, now);
  // 权限确认（第 1 层补的 approval）的按钮叫「去看看」，落到那个 session 的终端。
  const label: Record<NoticeAction, string> = { resume: S.noticeResume, retry: S.noticeRetry, health: S.noticeHealth, lessons: S.noticeLessons, open: n.kind === "approval" ? S.hm.act.look : S.noticeOpen, routing: S.rt.nowOpen, resend: S.noticeResend, raise: S.cs.raise, comments: S.lp.noticeOpen, stacks: S.sk.noticeOpen, undo: S.bt.undo, checks: S.bt.open, dismiss: S.bt.dismiss,
    intake: S.ik.noticeOpen, intakeStart: S.ik.actions.start, intakeSkip: S.ik.actions.skip, intakeParallel: S.ik.actions.allowParallel,
  };
  // 重发的结果（CI 结果未能送达）：送到了提醒会在下一次刷新时消失，没送到写上为什么。
  const [result, setResult] = useState<string | null>(null);
  const run = (a: NoticeAction): void => {
    if (a === "resume" || a === "retry") void api.availabilityAct({ op: "resumeLessons" }).catch(reportError);
    else if (a === "health") onGo({ page: "settings", section: "health" });
    else if (a === "lessons") onGo({ page: "lessons" });
    else if (a === "routing") onGo({ page: "settings", section: "routing" });
    else if (a === "raise" && n.kind === "cost") {
      setResult(null);
      void api.costResume(n.breaker.subjectKind, n.breaker.subjectId).then((r) => setResult(r.ok ? S.cs.raised(costAmount(r.cap, n.breaker.unit, S)) : S.cs.raiseGone), reportError);
    } else if (a === "resend" && n.kind === "ci_undelivered") {
      setResult(null);
      void api.ciResend(n.ci.item).then((r) => setResult(r === "sent" || r === "delivered" ? S.ciResendSent : r === "busy_delivering" ? S.ciResendBusy : S.ciResendNot(ciReasonText(r, S))), reportError);
    } else if (a === "comments" && n.kind === "comments_waiting") {
      // 打开 ticket 时直接停在「评论」标签。
      saveTab(`ticket:${n.waiting.ticketKey}`, "comments");
      saveTabOpen(`ticket:${n.waiting.ticketKey}`, true);
      onOpen(n.target);
    } else if (n.kind === "check_promoted" || n.kind === "check_demoted") {
      // 撤销：恢复成升降级之前的模式（提醒随之消失）；知道了：只关提醒。
      if (a === "checks") onGo({ page: "lessons", tab: "checks" });
      else if (a === "undo" && n.batchId !== null) {
        setResult(null);
        void api.backtestAct({ op: "undo", batchId: n.batchId }).then((r) => setResult(r.ok ? S.bt.undone : btError(r.error, S)), reportError);
      } else if (a === "dismiss") void api.backtestAct({ op: "dismissNotice", eventId: n.eventId }).catch(reportError);
    } else if (n.kind === "intake" && a !== "intake") {
      setResult(null);
      const op = a === "intakeStart" ? "start" : a === "intakeSkip" ? "skip" : "allowParallel";
      void api.intakeAct({ op, key: n.item.key }).then((r) => r.ok || setResult(intakeActError(r.message, S)), reportError);
    } else if (a === "stacks") onGo({ page: "all", section: "stacks" });
    else if (a === "intake") onGo({ page: "all", section: "intake" });
    else if (n.kind === "session_limited" || n.kind === "ci_undelivered" || n.kind === "approval") onOpen(n.target);
    else if (n.kind === "stack" && n.target) onOpen(n.target);
    else if (n.kind === "cost" && n.target) onOpen(n.target);
  };
  return (
    <div className="notice" data-testid={`now-notice-${n.kind}`}>
      <p>{text}</p>
      {result && <p className="muted" data-testid="now-notice-result">{result}</p>}
      <div className="actions">
        {actions.map((a) => <button key={a} data-testid={`now-notice-${n.kind}-${a}`} className={a === "raise" ? "primary" : undefined} onClick={() => run(a)}>{label[a]}</button>)}
      </div>
    </div>
  );
}
