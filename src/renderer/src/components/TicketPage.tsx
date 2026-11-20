import { useEffect, useRef, useState } from "react";
import type { Turn } from "../../../shared/turn";
import { TICKET_STATUSES, type Feature, type OpenSessionRequest, type TicketStatus, type TicketView } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { repoWhere } from "../repos";
import { ticketRows } from "../scope-view";
import { S, STATUS_LABEL } from "../strings";
import type { TicketTab } from "../ticket-tabs";
import { conversationSessions, ticketLanding } from "../ticket-view";
import { ConversationPlaceholder } from "./ConversationPlaceholder";
import { PageTabs } from "./PageTabs";
import { TicketHomeTab } from "./TicketHome";
import { TicketLogTab } from "./TicketLogTab";
import { TicketPrTab } from "./TicketPrTab";
import { TicketTerminalTab, useTicketTerminals } from "./TicketTerminalTab";
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
  const row = board === null ? null : (ticketRows([ticket], board.items)[0] ?? null);
  /** 落点只算一次：之后用户自己切页签不再被拉回；带着打开请求进来时落在终端，不再看卡片的轮次。 */
  const landed = useRef(false);

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
    const { tab, terminal: to } = ticketLanding(landing, ticket.sessions, term.panesRef.current);
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
            content: <TicketHomeTab ticket={ticket} onGoTab={goTab} onFix={onFix} answered={answered} onAnswered={(id, text) => setAnswered((m) => ({ ...m, [id]: text }))} />,
          },
          {
            id: "conversation", label: S.lay.tabConversation,
            content: <ConversationSlot ticket={ticket} />,
          },
          { id: "terminal", label: S.lay.tabTerminal, content: <TicketTerminalTab ticket={ticket} term={term} /> },
          { id: "pr", label: S.lay.tabPr, content: <TicketPrTab ticketKey={ticket.key} /> },
          { id: "log", label: S.lay.tabLog, content: <TicketLogTab ticketKey={ticket.key} /> },
        ]}
      />
    </div>
  );
}

/** 「对话」页签：只在停在这个页签时取链根。第 5 层把 ConversationPlaceholder 换成 ConversationTab，props 一致，只改这一行。 */
function ConversationSlot({ ticket }: { ticket: TicketView }) {
  const glance = useStateRefetch(`glance:${ticket.key}`, () => api.ticketGlance(ticket.key));
  if (glance === null) return null;
  const rootSessionId = glance.rootSessionId;
  return rootSessionId ? <ConversationPlaceholder rootSessionId={rootSessionId} sessions={conversationSessions(ticket.sessions, S)} /> : <p className="muted">{S.lay.convNoSession}</p>;
}
