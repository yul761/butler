import { useEffect, useState } from "react";
import type { ButlerView, InboxItemView, NowTarget, OpenSessionResult } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { epicErrorText } from "./epic-row";
import { inboxTabs, useInbox } from "./InboxPanes";
import { PageTabs } from "./PageTabs";
import { SessionArea, SessionButton, useSessionPanes } from "./WorkspaceParts";

/** hook 事件一来一串：合并成一次重读（和 App 的刷新一样）。 */
const STATE_DEBOUNCE_MS = 80;

/** Butler 总控页的数据：打开时取一次，之后每次 stateChanged 重取。还没取到时为 null。 */
function useButlerView(): ButlerView | null {
  const [view, setView] = useState<ButlerView | null>(null);
  useEffect(() => {
    let live = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      const n = ++seq;
      api.butlerView().then((v) => live && n === seq && setView(v), reportError);
    };
    load();
    const off = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, STATE_DEBOUNCE_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, []);
  return view;
}

interface Props {
  /** 打开时先切到这个 session 的终端（从「现在」页或「待你决定」点进来时）。 */
  focusSession?: string | null;
  /** 「待你决定」卡片上的「去终端」：问题不是 Butler 总控提的时跳到提问的 session 的页面。 */
  onOpenTarget: (t: NowTarget) => void;
}

/**
 * 关着的复盘分析 session 和复盘页的「在 Claude 里打开」走同一条路（重写运行记录，接着原来的对话打开，不再发消息）。
 * 打不开时抛出要显示的文字：运行或仓库不在了按 session 不存在报。
 */
async function openLessonSession(runId: number): Promise<OpenSessionResult> {
  const r = await api.lessonsAct({ op: "openInClaude", runId });
  if (r.ok && r.sessionId) return { ok: true, termId: r.sessionId, alreadyOpen: false };
  const reason = r.ok ? "no_session" : r.reason === "not_found" ? "no_session" : r.reason;
  throw new Error(S.openErrors[reason] ?? S.lessonsErrorGeneric);
}

/**
 * Butler 总控页（BTL-190 第 5 点）：上面是所有范围的「汇报 / 待你决定」两个 tab，下面是 Butler 总控的 session 和终端。
 * 没有仓库条：Butler 总控在自己的工作目录里，只读不改代码。
 */
export function ButlerPage({ focusSession, onOpenTarget }: Props) {
  const view = useButlerView();
  // 取到数据再建终端面板：面板一开始就要知道哪些终端开着。
  if (!view) return <div className="ticket-page butler-page" />;
  return <ButlerArea view={view} focusSession={focusSession} onOpenTarget={onOpenTarget} />;
}

function ButlerArea({ view, focusSession, onOpenTarget }: Props & { view: ButlerView }) {
  const [error, setError] = useState<string | null>(null);
  const errorText = (e: unknown) => epicErrorText(e, S);
  const inbox = useInbox({ all: true });
  // 复盘分析 session 和 Butler 总控的共用一组终端：从复盘页「在 Claude 里打开」跳过来时，focusSession 是复盘分析 session。
  const panes = useSessionPanes([...view.sessions, ...view.lessonSessions], {
    openSession: (sessionId) => {
      const runId = view.lessonSessions.find((s) => s.id === sessionId)?.lessonRunId;
      return runId ? openLessonSession(runId) : api.openButlerSession({ sessionId });
    },
    openFailure: (reason) => S.butlerOpenErrors[reason] ?? S.openErrors[reason] ?? reason,
    errorText,
    setError,
    initialActive: focusSession,
  });

  /** 「去终端」：Butler 总控自己的问题就地切过去，终端关着就打开；别的 session 跳到它的页面。 */
  function goTo(item: InboxItemView) {
    const t = item.target;
    if (t.page !== "butler") return onOpenTarget(t);
    const termId = view.sessions.find((s) => s.id === item.sessionId)?.termId;
    if (termId) panes.show(termId);
    else void panes.open(item.sessionId);
  }

  return (
    <div className="ticket-page butler-page">
      <header className="ticket-header">
        <h2>{S.butlerTitle}</h2>
        <span className="muted" title={view.workspaceDir}>{S.labelled(S.butlerWorkspace, view.workspaceDir)}</span>
      </header>
      <p className="muted butler-intro">{S.butlerIntro}</p>

      {/* 这一页就是来回答问题的：默认停在「待你决定」。 */}
      <PageTabs page="butler" defaultTab="decisions" tabs={inboxTabs(inbox, goTo)} />

      <SessionArea
        sessions={view.sessions}
        hiddenSessions={view.hiddenSessions}
        panes={panes}
        placeOf={() => S.butlerSession}
        noSessions={S.noButlerSessions}
        newSession={S.newButlerSession}
        newSessionHint={S.butlerSessionHint}
        error={error}
        onError={(e) => setError(errorText(e))}
      >
        {view.lessonSessions.length > 0 && (
          <section className="lesson-sessions">
            <h3>{S.lessonSessionsHeading}</h3>
            <div className="sessions-bar">
              {view.lessonSessions.map((s) => <SessionButton key={s.id} s={s} panes={panes} place={S.lessonSession} />)}
            </div>
          </section>
        )}
      </SessionArea>
    </div>
  );
}
