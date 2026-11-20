import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ButlerMessageView, ButlerView, OpenSessionResult } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { defaultConvRoot } from "../ticket-view";
import { epicErrorText } from "./epic-row";
import { ControlConversation } from "./ControlConversation";
import { ControlSplit } from "./ScopeParts";
import { SessionArea, SessionButton, useSessionPanes } from "./WorkspaceParts";
import { useStateRefetch } from "./useStateRefetch";

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
  /** 打开时先切到这个 session 的终端（从首页卡片点进来时）。 */
  focusSession?: string | null;
}

/**
 * 关着的复盘分析 session 和复盘页的「在 Claude 里打开」走同一条路（重写运行记录，接着原来的对话打开，不再发消息）。
 * 打不开时抛出要显示的文字：只有运行（或仓库）不在了和找不到 claude 有自己的说法，别的（写不了运行记录等）都是通用的失败。
 * 不用 openErrors：那里的 no_repo、no_ticket 说的是 ticket。
 */
async function openLessonSession(runId: number): Promise<OpenSessionResult> {
  const r = await api.lessonsAct({ op: "openInClaude", runId });
  if (r.ok && r.sessionId) return { ok: true, termId: r.sessionId, alreadyOpen: false };
  const reason = r.ok ? null : r.reason;
  throw new Error(reason === "not_found" ? S.lessonSessionGone : reason === "claude_missing" ? S.openErrors.claude_missing : S.lessonsErrorGeneric);
}

/** 总控页的版面：标题 + 一句话说明 + 左终端右对话。没有 tab。 */
export function ButlerLayout(p: { title: string; lede: string; meta?: ReactNode; left: ReactNode; right: ReactNode }) {
  return (
    <div className="ticket-page butler-page">
      <header className="ticket-header">
        <h2>{p.title}</h2>
        {p.meta}
      </header>
      <p className="muted butler-intro">{p.lede}</p>
      <ControlSplit page="butler" left={p.left} right={p.right} />
    </div>
  );
}

/**
 * Butler 总控页：左边是 Butler 总控的 session 和终端，右边是所有范围的汇报对话。
 * 没有仓库条：Butler 总控在自己的工作目录里，只读不改代码。
 */
export function ButlerPage({ focusSession }: Props) {
  const view = useButlerView();
  // 取到数据再建终端面板：面板一开始就要知道哪些终端开着。
  if (!view) return <div className="ticket-page butler-page" />;
  return <ButlerArea view={view} focusSession={focusSession} />;
}

function ButlerArea({ view, focusSession }: Props & { view: ButlerView }) {
  const [error, setError] = useState<string | null>(null);
  const errorText = (e: unknown) => epicErrorText(e, S);
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

  return (
    <ButlerLayout
      title={S.butlerTitle}
      lede={S.butlerIntro}
      meta={<span className="muted" title={view.workspaceDir}>{S.labelled(S.butlerWorkspace, view.workspaceDir)}</span>}
      left={
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
      }
      right={
        <ControlConversation
          scope={{ all: true }}
          rootSessionId={defaultConvRoot(view.sessions)}
          sessions={view.sessions.map((s) => ({ id: s.rootId, label: S.butlerSession }))}
          footer={<ButlerReplies />}
        />
      }
    />
  );
}

const shortTime = (iso: string) => new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 总控用 send_message 发出去的消息（ws-b）：送到没有，收到的回复送回总控没有。新的在前。 */
export function ButlerRepliesList({ messages }: { messages: ButlerMessageView[] }) {
  if (messages.length === 0) return <p className="muted">{S.butlerRepliesNone}</p>;
  return (
    <ul className="butler-replies" data-testid="butler-replies">
      {messages.map((m) => (
        <li key={m.requestId} className={`butler-message status-${m.status}`}>
          <div className="butler-message-head">
            <strong>{m.target}</strong>
            <span className={`badge status-${m.status}`}>{S.butlerMessageStatus[m.status]}</span>
            <span className="muted">{S.butlerMessageSent} {shortTime(m.queuedAt)}</span>
            {m.error && <span className="muted">· {m.error}</span>}
          </div>
          <p className="butler-message-text">{m.text}</p>
          {m.reply !== null && (
            <div className="butler-message-reply">
              <span className="muted">{S.butlerMessageReply}{m.repliedAt ? ` · ${shortTime(m.repliedAt)}` : ""}</span>
              <p>{m.reply}</p>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 对话下面默认折起的「总控发出的消息（N）」；还没取到消息时整块不显示。 */
export function ButlerRepliesSummary({ messages }: { messages: ButlerMessageView[] | null }) {
  if (messages === null) return null;
  return (
    <details className="butler-sent">
      <summary>{S.lay.butlerSent(messages.length)}</summary>
      <ButlerRepliesList messages={messages} />
    </details>
  );
}

function ButlerReplies() {
  const messages = useStateRefetch("butler:messages", () => api.butlerMessages());
  return <ButlerRepliesSummary messages={messages} />;
}
