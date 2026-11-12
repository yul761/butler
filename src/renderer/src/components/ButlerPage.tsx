import { useEffect, useState } from "react";
import type { ButlerView, InboxItemView, NowTarget } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { epicErrorText } from "./epic-row";
import { InboxPanes } from "./InboxPanes";
import { SessionArea, useSessionPanes } from "./WorkspaceParts";

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
 * Butler 总控页（BTL-190 第 5 点）：上面是所有范围的「汇报 / 待你决定」两栏，下面是 Butler 总控的 session 和终端。
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
  const panes = useSessionPanes(view.sessions, {
    openSession: (sessionId) => api.openButlerSession({ sessionId }),
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

      <InboxPanes scope={{ all: true }} onGo={goTo} alwaysShow />

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
      />
    </div>
  );
}
