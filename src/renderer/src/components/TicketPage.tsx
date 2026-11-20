import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Turn } from "../../../shared/turn";
import { TICKET_STATUSES, type Feature, type OpenSessionRequest, type TicketStatus, type TicketView } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { repoWhere } from "../repos";
import { ticketRows } from "../scope-view";
import { S, STATUS_LABEL } from "../strings";
import type { TicketTab } from "../ticket-tabs";
import { convFocusRoot, conversationSessions, ticketLanding } from "../ticket-view";
import { ConversationTab } from "./ConversationTab";
import { hibernationOf } from "./HibernateParts";
import { PageTabs } from "./PageTabs";
import { TicketHomeTab } from "./TicketHome";
import { TicketLogTab } from "./TicketLogTab";
import { TicketPrTab } from "./TicketPrTab";
import { TerminalPane } from "./TerminalPane";
import { TicketTerminalTab, useTicketTerminals, type TicketTerminals } from "./TicketTerminalTab";
import { TitleDialog } from "./TitleDialog";
import { useStateRefetch } from "./useStateRefetch";
import { useTurnBoard } from "./useTurnBoard";

interface Props {
  ticket: TicketView;
  onArchived: () => void;
  /** 从别的页面跳进来时要执行的打开请求（落在「终端」页签）。 */
  initialOpen?: OpenSessionRequest | null;
  onInitialOpenDone?: () => void;
  /** 从卡片的「去看看」进来：那张卡片的轮次；页面打开时按它落一次（ticketLanding）。 */
  landing?: Turn;
  /** 开修复 session（同首页 TurnCard）。 */
  onFix: (featureId: number, stuckSessionId: string) => void;
  /** ticket 属于的 feature（设计文档 2026-10-26）。 */
  feature?: Pick<Feature, "id" | "name"> | null;
  onOpenFeature?: (id: number) => void;
}

/** ticket 页（UI 重做第 3 层，spec §5.3）：标题栏下五个页签——概况、对话、终端、PR 详情、记录。 */
export function TicketPage({ ticket, onArchived, initialOpen = null, onInitialOpenDone, landing, onFix, feature = null, onOpenFeature }: Props) {
  // 终端状态留在页面里：切到别的页签再回来，终端从快照重建，不丢。
  const term = useTicketTerminals(ticket);
  const [editingTitle, setEditingTitle] = useState(false);
  /** 页签落点：n 递增，同一个页签也能再落一次。 */
  const [force, setForce] = useState<{ tab: TicketTab; n: number } | null>(() => (initialOpen ? { tab: "terminal", n: 0 } : null));
  const goTab = (tab: TicketTab) => setForce((f) => ({ tab, n: (f?.n ?? 0) + 1 }));
  const { board } = useTurnBoard({ ticketKey: ticket.key });
  /** 概况提问行上答过、还没送进去的提问（askId -> 回答）：放在页面上，切到别的页签再回来还在。 */
  const [answered, setAnswered] = useState<Record<number, string>>({});
  /** 提问行上的回答请求在路上：和 answered 一样放在页面上，切页签不丢。 */
  const [askBusy, setAskBusy] = useState(false);
  const row = board === null ? null : (ticketRows([ticket], board.items)[0] ?? null);
  /** 落点只算一次：之后用户自己切页签不再被拉回；带着打开请求进来时落在终端，不再看卡片的轮次。 */
  const landed = useRef(false);
  /** 落在对话时要选中的 session（轮到你的那个）；n 递增，让已经开着的对话 tab 也换过去。 */
  const [convFocus, setConvFocus] = useState<{ sessionId: string; n: number } | null>(null);

  // 从别的页面跳进来时的打开请求：恢复 session 并预填提示，切到终端页签，只执行一次。
  useEffect(() => {
    if (!initialOpen) return;
    landed.current = true;
    onInitialOpenDone?.();
    goTab("terminal");
    void term.open(initialOpen);
  }, [initialOpen]);

  // 卡片带着轮次进来：页面一打开就落（不等看板，看板回来前用户点的页签不会被拉回）。
  useEffect(() => {
    if (!landing || landed.current) return;
    landed.current = true;
    const { tab, terminal: to, conversation } = ticketLanding(landing, ticket.sessions, term.panesRef.current);
    if (conversation !== null) setConvFocus((f) => ({ sessionId: conversation, n: (f?.n ?? 0) + 1 }));
    goTab(tab);
    // 落在终端：顺手切到（或恢复）轮到你的那个 session。
    if (to === null) return;
    if ("activate" in to) term.setActive(to.activate);
    else void term.open({ ticketKey: ticket.key, sessionId: to.open });
  }, [landing]);

  const statusValue = ticket.statusManual ?? "auto";

  return (
    <div className="ticket-page">
      <header className="ticket-header">
        <h2>{ticket.key}{ticket.title && <span className="title"> · {ticket.title}</span>}</h2>
        <span className="muted">{ticket.repos.length === 1 ? repoWhere(ticket.repos[0]) : ""}</span>
        <select
          value={statusValue}
          onChange={(e) => api.setStatus(ticket.key, e.target.value === "auto" ? null : (e.target.value as TicketStatus)).catch(reportError)}
        >
          <option value="auto">{S.statusAuto(STATUS_LABEL[ticket.status])}</option>
          {TICKET_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button onClick={() => setEditingTitle(true)}>{S.editTitle}</button>
        <button onClick={() => api.archive(ticket.key).then(onArchived, reportError)}>{S.archive}</button>
      </header>
      {feature && (
        <div className="muted feature-link">
          {S.inFeature} <button className="link" onClick={() => onOpenFeature?.(feature.id)}>{feature.name}</button>
        </div>
      )}
      {editingTitle && <TitleDialog ticket={ticket} onClose={() => setEditingTitle(false)} />}

      <PageTabs
        page={`ticket:${ticket.key}`}
        defaultTab="overview"
        forceTab={force?.tab ?? null}
        forceSeq={force?.n}
        tabs={[
          {
            id: "overview", label: S.lay.tabOverview, className: row !== null && (row.turn.owner === "you" || row.asks.length > 0) ? "attention" : undefined,
            content: <TicketHomeTab ticket={ticket} onGoTab={goTab} onFix={onFix} answered={answered} onAnswered={(id, text) => setAnswered((m) => ({ ...m, [id]: text }))} busy={askBusy} onBusy={setAskBusy} />,
          },
          {
            id: "conversation", label: S.lay.tabConversation,
            content: <ConversationSlot ticket={ticket} focus={convFocus} renderTerminal={(id) => <SideTerminal ticket={ticket} term={term} sessionId={id} onGoTab={goTab} />} />,
          },
          { id: "terminal", label: S.lay.tabTerminal, content: <TicketTerminalTab ticket={ticket} term={term} /> },
          { id: "pr", label: S.lay.tabPr, content: <TicketPrTab ticketKey={ticket.key} /> },
          { id: "log", label: S.lay.tabLog, content: <TicketLogTab ticketKey={ticket.key} /> },
        ]}
      />
    </div>
  );
}

/** 「对话」页签：只在停在这个页签时取链根。 */
function ConversationSlot({ ticket, focus, renderTerminal }: {
  ticket: TicketView; focus: { sessionId: string; n: number } | null; renderTerminal: (sessionId: string) => ReactNode;
}) {
  const glance = useStateRefetch(`glance:${ticket.key}`, () => api.ticketGlance(ticket.key));
  if (glance === null) return null;
  if (!glance.rootSessionId) return <p className="muted">{S.lay.convNoSession}</p>;
  // 从卡片落进来：选中轮到你的那个 session 的链；否则是 ticket 的主链。
  const rootSessionId = convFocusRoot(ticket.sessions, focus?.sessionId ?? null, glance.rootSessionId);
  return (
    <ConversationTab
      rootSessionId={rootSessionId} focusKey={focus?.n} sessions={conversationSessions(ticket.sessions, S)}
      renderTerminal={renderTerminal} page={`ticket:${ticket.key}`}
    />
  );
}

/**
 * 对话 tab「并排显示终端」的左边：同一个 TerminalPane（同终端 tab 一样的 termId、休眠、关闭和恢复），状态是 TicketPage 已有的那份。
 * sessionId 是链上任意一段（对话 tab 用链根）；没开着就说一句，给个按钮去终端 tab 打开。
 */
function SideTerminal({ ticket, term, sessionId, onGoTab }: { ticket: TicketView; term: TicketTerminals; sessionId: string; onGoTab: (tab: TicketTab) => void }) {
  const s = ticket.sessions.find((x) => x.id === sessionId) ?? ticket.sessions.find((x) => x.rootId === sessionId);
  const termId = s?.termId ?? null;
  if (termId === null) {
    return (
      <div className="conv-term-closed">
        <p className="muted">{S.conv.termClosed}</p>
        <button onClick={() => onGoTab("terminal")}>{S.conv.openInTerminalTab}</button>
      </div>
    );
  }
  return (
    <div className="terminals">
      <TerminalPane
        key={termId} termId={termId} visible hibernated={hibernationOf(ticket.sessions, termId)}
        onClose={() => term.closePane(termId)} onResume={() => void term.open({ ticketKey: ticket.key, sessionId: termId })}
      />
    </div>
  );
}
