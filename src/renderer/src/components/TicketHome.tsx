// ticket 页的「概况」页签（UI 重做第 3 层，spec §5.3）：一句状态、主按钮、agent 最后说的那句话、「状态」（最新一份 handoff，BTL-244）、一小块基本信息。
// TicketHome 只吃数据；TicketHomeTab 是取数薄壳。
import { TicketWorkflow } from "./WorkflowParts";
import { useState, type ReactNode } from "react";
import type { PrStagesTicket } from "../../../shared/pr-stages";
import type { TicketGlance } from "../../../shared/ticket-glance";
import type { TurnItem } from "../../../shared/turn";
import type { HandoffRecord, TicketView } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { outcomeMessage } from "../followup-view";
import { cardActions, type CardAction } from "../home-view";
import { usePrStages } from "../pr-stages-view";
import type { TicketRow } from "../scope-view";
import { ticketRows } from "../scope-view";
import { S, type UiStrings } from "../strings";
import { landingTab, type TicketTab } from "../ticket-tabs";
import { clipSaid, contextLine, mainActions, prStageLine, prUrlOf, type MainAction } from "../ticket-view";
import { turnSentence } from "../turn-text";
import { GroupToggle } from "./HomeMore";
import { RepoDialog } from "./RepoDialog";
import { WhoTag } from "./ScopeParts";
import { TicketStatus, type TicketStatusProps } from "./TicketStatus";
import { useCollapsed } from "./useCollapsed";
import { runCardAction, sendReasonText, type CardOutcome } from "../turn-card-actions";
import { useStateRefetch } from "./useStateRefetch";
import { useTurnBoard } from "./useTurnBoard";
import { GLANCE_SCOPES } from "../state-bus";

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
  /** 在 ticket 页答过、还没送进去的提问：askId -> 回答。这一行改成「已回答…」，不再出选项（记在 TicketPage 上，切页签不丢；离开这个 ticket 就没了）。 */
  answered: Readonly<Record<number, string>>;
  /** 提问的回答正在送：提问行的按钮先禁用，免得连点覆盖答案。 */
  busy: boolean;
  /** 「状态」一节（最新一份 handoff 和「更新状态」）。 */
  status: TicketStatusProps;
  onGoTab: (t: TicketTab) => void;
  onOpenPr: (url: string) => void;
  onSend: () => void;
  onFix: () => void;
  /** 提问行上的按钮（和首页卡片同一套 cardActions）：由 TicketHomeTab 交给 runTicketAsk。 */
  onAsk: (a: CardAction, item: TurnItem) => void;
  /** 还没开过 session 时的「开第一个 session」（BTL-249）：开在第一个仓库里、切到终端页签，由页面做。 */
  onStartSession?: () => void;
  /** 还没有仓库时的「添加仓库」。 */
  onAddRepo?: () => void;
}

const noop = () => {};

/**
 * 提问行按钮的动作，走首页卡片那条路（runCardAction）：选项经 inbox 回答，回答先存下来，等发问的 session 下次停下来
 * （session 结束了就等它恢复以后）再送进去；「去看看」落到这张卡片的轮次对应的页签。返回和首页卡片一样的结果。
 */
export async function runTicketAsk(
  a: CardAction, item: TurnItem,
  d: { answerInbox: (id: number, text: string) => Promise<boolean>; onGoTab: (t: TicketTab) => void; onChanged: () => void }, s: UiStrings,
): Promise<CardOutcome> {
  return runCardAction(a, item, {
    answerInbox: d.answerInbox,
    prOpen: () => Promise.resolve({ ok: true }),
    turnSendToAgent: () => Promise.resolve({ ok: false }),
    dismissActivity: () => Promise.resolve(),
    onOpen: noop,
    onGo: (r) => d.onGoTab(r.page === "ticket" && r.landing ? landingTab(r.landing) : "overview"),
    onFix: noop,
    // 回答以后板子随 turn:changed 自己重取；问题已经不在了（别处答过）时没有 turn:changed，要自己重取，和首页一样。
    onChanged: d.onChanged,
  }, s);
}

export function TicketHome({ ticket, row, glance, stages, canFix, notice, answered, busy, status, onGoTab, onOpenPr, onSend, onFix, onAsk, onStartSession, onAddRepo }: TicketHomeProps) {
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
  // 还没开 PR 时直接说（和分支、PR 号一样不收起）；有 PR 时阶段进度收进「细节」（BTL-244）。
  const prLine = stages === null ? null : prStageLine(stages, S);
  const noPr = prLine === S.lay.noPrYet;
  const stageLine = noPr ? null : prLine;
  // 一个 session 都没开过（隐藏的也算开过）：「最后一句」没有意义，换成开始的入口（BTL-249）。
  const neverStarted = ticket.sessions.length === 0 && (ticket.hiddenSessions ?? []).length === 0;
  const noRepo = ticket.repos.length === 0;
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
          {row.asks.map((a, n) => {
            const done = a.turn.kind === "answer" && a.turn.askId !== null ? answered[a.turn.askId] : undefined;
            return (
              <p key={a.turn.kind === "answer" ? a.turn.askId : n} className="ticket-home-state">
                <WhoTag turn={a.turn} />
                <span className="sentence">{turnSentence(a.turn, a, S)}</span>
                {done !== undefined ? <span className="muted" role="status">{S.hm.act.answered(done)}</span> : cardActions(a).map((c) => (
                  <button key={c.id === "answer" ? `answer:${c.option}` : c.id} className={c.primary ? "primary" : undefined} disabled={busy} onClick={() => onAsk(c, a)}>
                    {c.id === "answer" ? c.option : S.hm.act[c.id]}
                  </button>
                ))}
              </p>
            );
          })}
        </section>
      )}
      {notice && <p className="muted" role="status">{notice}</p>}
      {neverStarted && (
        <section className="ticket-home-first" data-testid="ticket-first-session">
          <p>{noRepo ? S.lay.firstSessionNoRepo : S.lay.firstSessionHint}</p>
          <div className="actions">
            {noRepo
              ? <button className="primary" onClick={onAddRepo ?? (() => onGoTab("terminal"))}>{`+ ${S.lay.addRepoFirst}`}</button>
              : <button className="primary" onClick={onStartSession ?? (() => onGoTab("terminal"))}>{S.lay.startFirstSession}</button>}
          </div>
        </section>
      )}
      {glance !== null && !neverStarted && (
        <section className="ticket-home-said">
          <h3>{S.lay.lastSaid}</h3>
          {glance.lastSaid === null ? <p className="muted">{S.lay.lastSaidNone}</p> : <p className="said">{clipSaid(glance.lastSaid.text)}</p>}
          <button onClick={() => onGoTab("conversation")}>{S.lay.seeConversation}</button>
        </section>
      )}
      <TicketStatus {...status} />
      <section className="ticket-home-info">
        <h3>{S.lay.thisTicket}</h3>
        {(branches !== "" || noPr) && (
          <dl className="kv">
            {branches !== "" && <><dt>{S.lay.kvBranch}</dt><dd>{branches}</dd></>}
            {noPr && <><dt>{S.lay.kvPr}</dt><dd>{S.lay.noPrYet}</dd></>}
          </dl>
        )}
        {(stageLine !== null || ctx !== null) && (
          <DetailsFold ticketKey={ticket.key}>
            <dl className="kv">
              {stageLine !== null && <><dt>{S.lay.kvPr}</dt><dd>{stageLine}</dd></>}
              {ctx !== null && <><dt>{S.lay.kvContext}</dt><dd>{ctx.text}{ctx.nearRefresh && <span className="muted"> · {S.lay.ctxNear}</span>}</dd></>}
            </dl>
          </DetailsFold>
        )}
      </section>
    </div>
  );
}

/** 「细节」：PR 阶段和上下文 token，默认收起，按 ticket 记住开合（BTL-244）。 */
function DetailsFold({ ticketKey, children }: { ticketKey: string; children: ReactNode }) {
  const [collapsed, toggle] = useCollapsed(`ticket-home-details:${ticketKey}`, true);
  return (
    <div className="ticket-home-details">
      <GroupToggle open={!collapsed} onToggle={toggle}>{S.lay.homeDetails}</GroupToggle>
      {!collapsed && children}
    </div>
  );
}

export interface TicketHomeTabProps {
  ticket: TicketView;
  onGoTab: (t: TicketTab) => void;
  /** 开修复 session 并导航由页面做，失败也由页面报。 */
  onFix: (featureId: number, stuckSessionId: string) => void;
  /** 答过的提问由 TicketPage 记着：页签切走时这一块会卸载，状态放这里会丢，再回来又能点选项悄悄换掉答案。 */
  answered: Readonly<Record<number, string>>;
  onAnswered: (askId: number, text: string) => void;
  /** 回答请求还没回来：也放在 TicketPage 上，请求途中切走再切回，按钮照样禁用，不会再答一次。 */
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /** 「开第一个 session」（BTL-249）。 */
  onStartSession: () => void;
}

export function TicketHomeTab({ ticket, onGoTab, onFix, answered, onAnswered, busy, onBusy, onStartSession }: TicketHomeTabProps) {
  const key = ticket.key;
  const { board, reload } = useTurnBoard({ ticketKey: key });
  const glance = useStateRefetch(`glance:${key}`, () => api.ticketGlance(key), { scopes: GLANCE_SCOPES });
  const stages = usePrStages({ ticketKey: key })?.find((t) => t.ticketKey === key) ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  const [addingRepo, setAddingRepo] = useState(false);
  // 最新一份 handoff 就是这个 ticket 的「状态」：存下新的一份会发 stateChanged，这里跟着重取。
  const history = useStateRefetch(`handoffs:${key}`, () => api.handoffs(key));
  const [running, setRunning] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const runStatus = () => {
    setRunning(true);
    setStatusMessage(null);
    api.runHandoff(key).then((o) => setStatusMessage(outcomeMessage(o)), reportError).finally(() => setRunning(false));
  };
  const latest: HandoffRecord | null | undefined = history === null ? undefined : (history[0] ?? null);
  const row = board === null ? null : (ticketRows([ticket], board.items)[0] ?? null);
  const turn = row?.turn;
  const stuckSession = turn?.owner === "you" && turn.kind === "stuck" ? turn.sessionId : null;
  const canFix = ticket.featureId !== null && stuckSession !== null;
  const pr = row?.item.pr ?? null;
  return (
    <>
    {addingRepo && <RepoDialog ticketKey={key} hasSessions={false} onClose={() => setAddingRepo(false)} />}
    <TicketWorkflow ticketKey={key} />
    <TicketHome
      ticket={ticket} row={row} glance={glance} stages={stages} canFix={canFix} notice={notice} answered={answered} busy={busy} onGoTab={onGoTab}
      onStartSession={onStartSession} onAddRepo={() => setAddingRepo(true)}
      status={{ latest, running, message: statusMessage, onRun: runStatus }}
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
      onAsk={(a, item) => {
        if (busy) return;
        setNotice(null);
        onBusy(true);
        runTicketAsk(a, item, { answerInbox: api.answerInbox, onGoTab, onChanged: reload }, S).then((r) => {
          if (r === null) return;
          if ("message" in r) setNotice(r.message);
          // 有回答就一定有 askId（runCardAction 对没有 askId 的提问不回答）。
          else if (item.turn.kind === "answer" && item.turn.askId !== null) onAnswered(item.turn.askId, r.answered);
        }, reportError).finally(() => onBusy(false));
      }}
    />
    </>
  );
}
