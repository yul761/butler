// ticket 页的「概况」页签（UI 重做第 3 层，spec §5.3）：一句状态、主按钮、agent 最后说的那句话、一小块基本信息。
// TicketHome 只吃数据；TicketHomeTab 是取数薄壳。
import { useState } from "react";
import type { PrStagesTicket } from "../../../shared/pr-stages";
import type { TicketGlance } from "../../../shared/ticket-glance";
import type { TicketView } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { usePrStages } from "../pr-stages-view";
import type { TicketRow } from "../scope-view";
import { ticketRows } from "../scope-view";
import { S } from "../strings";
import type { TicketTab } from "../ticket-tabs";
import { clipSaid, contextLine, mainActions, prStageLine, prUrlOf, type MainAction } from "../ticket-view";
import { turnSentence } from "../turn-text";
import { WhoTag } from "./ScopeParts";
import { sendReasonText } from "../turn-card-actions";
import { useStateRefetch } from "./useStateRefetch";
import { useTurnBoard } from "./useTurnBoard";

export interface TicketHomeProps {
  ticket: TicketView;
  /** turn:board 还没回来为 null。 */
  row: TicketRow | null;
  /** 还没取到为 null。 */
  glance: TicketGlance | null;
  /** 还没取到为 null；没有仓库或没有 PR 时 rows 为空。 */
  stages: PrStagesTicket | null;
  /** 能不能开修复 session（规则同 TurnCard），由调用方算好。 */
  canFix: boolean;
  /** 「送给 agent」没送成时的一句话。 */
  notice: string | null;
  onGoTab: (t: TicketTab) => void;
  onOpenPr: (url: string) => void;
  onSend: () => void;
  onFix: () => void;
}

export function TicketHome({ ticket, row, glance, stages, canFix, notice, onGoTab, onOpenPr, onSend, onFix }: TicketHomeProps) {
  if (row === null) return <div className="ticket-home ticket-home-skeleton" aria-busy="true"><p className="muted">…</p></div>;
  const url = prUrlOf(row.item.pr, stages);
  const actions = mainActions(row.turn, { hasPr: url !== null, canFix }, S);
  const run = (a: MainAction) => {
    if (a.id === "open_pr") {
      if (url !== null) onOpenPr(url);
    } else if (a.id === "send") onSend();
    else if (a.id === "fix") onFix();
    else if (a.goTab) onGoTab(a.goTab);
  };
  const prTag = row.item.pr === null ? "" : `#${row.item.pr.number} `;
  const branches = [...new Set(ticket.repos.map((r) => r.branch))].join(", ");
  const ctx = glance === null ? null : contextLine(glance.context, S);
  return (
    <div className="ticket-home">
      <p className="ticket-home-state">
        <WhoTag turn={row.turn} />
        <span className="sentence">{prTag}{turnSentence(row.turn, row.item, S)}{row.others > 0 ? ` · ${S.lay.morePrs(row.others)}` : ""}</span>
      </p>
      {actions.length > 0 && (
        <div className="actions">
          {actions.map((a) => <button key={a.id} className={a.primary ? "primary" : undefined} onClick={() => run(a)}>{a.label}</button>)}
        </div>
      )}
      {row.asks.length > 0 && (
        <section className="ticket-home-asks">
          {row.asks.map((a, n) => (
            <p key={a.turn.kind === "answer" ? a.turn.askId : n} className="ticket-home-state">
              <WhoTag turn={a.turn} />
              <span className="sentence">{turnSentence(a.turn, a, S)}</span>
              <button className="primary" onClick={() => onGoTab("terminal")}>{S.lay.actAnswer}</button>
            </p>
          ))}
        </section>
      )}
      {notice && <p className="muted" role="status">{notice}</p>}
      {glance !== null && (
        <section className="ticket-home-said">
          <h3>{S.lay.lastSaid}</h3>
          {glance.lastSaid === null ? <p className="muted">{S.lay.lastSaidNone}</p> : <p className="said">{clipSaid(glance.lastSaid.text)}</p>}
          <button onClick={() => onGoTab("conversation")}>{S.lay.seeConversation}</button>
        </section>
      )}
      <section className="ticket-home-info">
        <h3>{S.lay.thisTicket}</h3>
        <dl className="kv">
          {branches !== "" && <><dt>{S.lay.kvBranch}</dt><dd>{branches}</dd></>}
          {stages !== null && <><dt>{S.lay.kvPr}</dt><dd>{prStageLine(stages, S)}</dd></>}
          {ctx !== null && <><dt>{S.lay.kvContext}</dt><dd>{ctx.text}{ctx.nearRefresh && <span className="muted"> · {S.lay.ctxNear}</span>}</dd></>}
        </dl>
      </section>
    </div>
  );
}

export interface TicketHomeTabProps {
  ticket: TicketView;
  onGoTab: (t: TicketTab) => void;
  /** 开修复 session 并导航由页面做，失败也由页面报。 */
  onFix: (featureId: number, stuckSessionId: string) => void;
}

export function TicketHomeTab({ ticket, onGoTab, onFix }: TicketHomeTabProps) {
  const key = ticket.key;
  const { board } = useTurnBoard({ ticketKey: key });
  const glance = useStateRefetch(`glance:${key}`, () => api.ticketGlance(key));
  const stages = usePrStages({ ticketKey: key })?.find((t) => t.ticketKey === key) ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  const row = board === null ? null : (ticketRows([ticket], board.items)[0] ?? null);
  const turn = row?.turn;
  const stuckSession = turn?.owner === "you" && turn.kind === "stuck" ? turn.sessionId : null;
  const canFix = ticket.featureId !== null && stuckSession !== null;
  const pr = row?.item.pr ?? null;
  return (
    <TicketHome
      ticket={ticket} row={row} glance={glance} stages={stages} canFix={canFix} notice={notice} onGoTab={onGoTab}
      onOpenPr={(url) => api.prOpen(url).catch(reportError)}
      onSend={() => {
        if (pr === null) return;
        setNotice(null);
        api.turnSendToAgent({ ticketKey: key, pr: { repo: pr.repo, number: pr.number } }).then((r) => {
          if (!r.ok) setNotice(S.hm.act.sendNot(sendReasonText(r.reason, S)));
        }, reportError);
      }}
      onFix={() => {
        if (ticket.featureId !== null && stuckSession !== null) onFix(ticket.featureId, stuckSession);
      }}
    />
  );
}
