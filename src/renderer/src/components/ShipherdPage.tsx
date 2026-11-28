import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ShipherdView, OpenSessionResult } from "../../../shared/types";
import { api, ShipherdError } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { defaultConvRoot } from "../ticket-view";
import { ControlConversation } from "./ControlConversation";
import { Messages } from "./MessageList";
import { InfoFlowSummary } from "./InfoFlow";
import { ControlSplit } from "./ScopeParts";
import { SessionArea, SessionButton, useSessionPanes } from "./WorkspaceParts";
import { LIVE_SCOPES } from "../state-bus";

/** hook 事件一来一串：合并成一次重读（和 App 的刷新一样）。 */
const STATE_DEBOUNCE_MS = 80;

/** Shipherd 总控页的数据：打开时取一次，之后每次 stateChanged 重取。还没取到时为 null。 */
function useShipherdView(): ShipherdView | null {
  const [view, setView] = useState<ShipherdView | null>(null);
  useEffect(() => {
    let live = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      const n = ++seq;
      api.shipherdView().then((v) => live && n === seq && setView(v), reportError);
    };
    load();
    // Shipherd 页带着各个 session 在干什么（BTL-242）。
    const off = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, STATE_DEBOUNCE_MS);
    }, LIVE_SCOPES);
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
export function ShipherdLayout(p: { title: string; lede: string; meta?: ReactNode; left: ReactNode; right: ReactNode }) {
  return (
    <div className="ticket-page shipherd-page">
      <header className="ticket-header">
        <h2>{p.title}</h2>
        {p.meta}
      </header>
      <p className="muted shipherd-intro">{p.lede}</p>
      <ControlSplit page="shipherd" left={p.left} right={p.right} />
    </div>
  );
}

/**
 * Shipherd 总控页：左边是 Shipherd 总控的 session 和终端，右边是所有范围的汇报对话。
 * 没有仓库条：Shipherd 总控在自己的工作目录里，只读不改代码。
 */
export function ShipherdPage({ focusSession }: Props) {
  const view = useShipherdView();
  // 取到数据再建终端面板：面板一开始就要知道哪些终端开着。
  if (!view) return <div className="ticket-page shipherd-page" />;
  return <ShipherdArea view={view} focusSession={focusSession} />;
}

function ShipherdArea({ view, focusSession }: Props & { view: ShipherdView }) {
  const [error, setError] = useState<string | null>(null);
  const errorText = (e: unknown) => (e instanceof ShipherdError ? (S.createErrors[e.code] ?? e.message) : (e as Error).message);
  // 复盘分析 session 和 Shipherd 总控的共用一组终端：从复盘页「在 Claude 里打开」跳过来时，focusSession 是复盘分析 session。
  const panes = useSessionPanes([...view.sessions, ...view.lessonSessions], {
    openSession: (sessionId) => {
      const runId = view.lessonSessions.find((s) => s.id === sessionId)?.lessonRunId;
      return runId ? openLessonSession(runId) : api.openShipherdSession({ sessionId });
    },
    openFailure: (reason) => S.shipherdOpenErrors[reason] ?? S.openErrors[reason] ?? reason,
    errorText,
    setError,
    initialActive: focusSession,
  });

  return (
    <ShipherdLayout
      title={S.shipherdTitle}
      lede={S.shipherdIntro}
      meta={<span className="muted" title={view.workspaceDir}>{S.labelled(S.shipherdWorkspace, view.workspaceDir)}</span>}
      left={
        <SessionArea
          sessions={view.sessions}
          hiddenSessions={view.hiddenSessions}
          panes={panes}
          placeOf={() => S.shipherdSession}
          noSessions={S.noShipherdSessions}
          newSession={S.newShipherdSession}
          newSessionHint={S.shipherdSessionHint}
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
          sessions={view.sessions.map((s) => ({ id: s.rootId, label: S.shipherdSession }))}
          footer={<><Messages scope={{ shipherd: true }} /><InfoFlowSummary scope={{ all: true }} /></>}
        />
      }
    />
  );
}

