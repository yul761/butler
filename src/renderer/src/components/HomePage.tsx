// 首页「轮到你」（UI 重做第 2 层，spec §5.3）：标题和一句概况、要你动手的卡片、各个 feature 的小表、
// 折起来的「进行中」和「运行情况」。数据都来自第 1 层的 turn:board，这里只排版。
import { useState, type ReactNode } from "react";
import type { NowView } from "../../../shared/types";
import type { Route } from "../App";
import {
  barSegments, capCards, cardKey, homeLede, homeTitle, runningRows, scopeLine, scopeRoute, visibleScopes, youCards, type NameCtx,
} from "../home-view";
import { S } from "../strings";
import { HomeMore, GroupToggle, SetupSkipped } from "./HomeMore";
import { useNow } from "./TicketActivity";
import { RunRow } from "./ScopeParts";
import { TurnCard, type TurnCardProps } from "./TurnCard";
import type { TurnBoardState } from "./useTurnBoard";
import { useCollapsed } from "./useCollapsed";
import type { TurnBoard } from "../../../shared/turn";

export interface HomeBodyProps {
  board: TurnBoard | null;
  /** 最近一次拉取的错误；board 非空时表示「旧数据」。 */
  error: string | null;
  /** 一件工作都没有：整页只放 firstRun。 */
  noWork: boolean;
  firstRun: ReactNode;
  ctx: NameCtx;
  now: number;
  /** 给「运行情况」里的旧块；还没取到时为 null。 */
  nowView: NowView | null;
  liveTickets: Set<string>;
  onRetry: () => void;
  onFix: TurnCardProps["onFix"];
  onOpen: TurnCardProps["onOpen"];
  onGo: (r: Route) => void;
  onOpenTicket: (key: string) => void;
  onChanged: () => void;
  onResumeSetup: () => void;
}

export function HomeBody(p: HomeBodyProps) {
  const setup = <SetupSkipped onResumeSetup={p.onResumeSetup} />;
  if (p.noWork) return <div className="page home-page">{setup}{p.firstRun}</div>;
  if (!p.board) {
    return (
      <div className="page home-page">
        {setup}
        {p.error ? <BoardFailed onRetry={p.onRetry} /> : <p className="muted">{S.loading}</p>}
      </div>
    );
  }
  const b = p.board;
  const cards = youCards(b.items);
  return (
    <div className="page home-page">
      {setup}
      <header className="home-top">
        <h2>{homeTitle(cards.length, S)}</h2>
        <p className="muted">{homeLede(b.counts, S)}</p>
      </header>
      {p.error && (
        <p className="home-stale muted" role="status">
          {S.hm.boardStale} <button className="link" onClick={p.onRetry}>{S.hm.retry}</button>
        </p>
      )}
      <Cards cards={cards} {...p} />
      <Scopes board={b} onGo={p.onGo} />
      <Running board={b} now={p.now} onOpenTicket={p.onOpenTicket} />
      <More {...p} />
    </div>
  );
}

/** App 用的：只多一个每分钟走一次的 now。 */
export function HomePage({ state, ...p }: Omit<HomeBodyProps, "now" | "board" | "error" | "onRetry"> & { state: TurnBoardState }) {
  const now = useNow();
  return <HomeBody {...p} now={now} board={state.board} error={state.error} onRetry={state.reload} />;
}

function BoardFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="home-failed" role="alert">
      <p>{S.hm.boardFailed}</p>
      <button onClick={onRetry}>{S.hm.retry}</button>
    </div>
  );
}

function Cards({ cards, ctx, now, onFix, onOpen, onGo, onChanged }: { cards: ReturnType<typeof youCards> } & HomeBodyProps) {
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = capCards(cards, expanded);
  if (cards.length === 0) return null;
  return (
    <section className="home-cards">
      {shown.map((item) => (
        <TurnCard key={cardKey(item)}
          item={item} ctx={ctx} now={now} onFix={onFix} onOpen={onOpen} onGo={onGo} onChanged={onChanged} />
      ))}
      {hidden > 0 && <button className="link" onClick={() => setExpanded(true)}>{S.hm.showAll(cards.length)}</button>}
    </section>
  );
}

function Scopes({ board, onGo }: { board: TurnBoard; onGo: (r: Route) => void }) {
  if (board.scopes.length === 0) return null;
  const { shown, hidden } = visibleScopes(board.scopes);
  return (
    <section className="home-scopes">
      <h3>{S.hm.scopesHeading}</h3>
      {shown.map((row) => (
        <div key={`${row.kind}:${row.id}`} className="home-scope" data-testid={`home-scope-${row.kind}-${row.id}`}>
          <button className="name" title={row.name} onClick={() => onGo(scopeRoute(row))}>{row.name}</button>
          <span className="line muted">{scopeLine(row, S)}</span>
          <div className="turn-bar">
            {barSegments(row.bar, row.total).map((s) => <i key={s.tone} className={`turn-${s.tone}`} style={{ width: `${s.pct}%` }} />)}
          </div>
          <span className="who">{row.youCount > 0 && <span className="turn-tag turn-ask">{S.hm.whoYou(row.youCount)}</span>}</span>
        </div>
      ))}
      {hidden > 0 && <button className="link" onClick={() => onGo({ page: "all" })}>{S.hm.scopeMore(board.scopes.length)}</button>}
    </section>
  );
}

function Running({ board, now, onOpenTicket }: { board: TurnBoard; now: number; onOpenTicket: (key: string) => void }) {
  // 这个记号在存储里的意思是「展开了」，默认收起。
  const [open, toggle] = useCollapsed("home:running");
  const rows = runningRows(board.items, S, now);
  return (
    <section className="home-running">
      <h3><GroupToggle open={open} onToggle={toggle}>{S.hm.running(rows.length)}</GroupToggle></h3>
      {open && rows.map((r) => (
        <RunRow key={r.key} row={r} onOpenTicket={onOpenTicket} />
      ))}
    </section>
  );
}

function More({ nowView, onOpen, onOpenTicket, liveTickets, onGo }: HomeBodyProps) {
  const [open, toggle] = useCollapsed("home:more");
  return (
    <section className="home-more-fold">
      <h3><GroupToggle open={open} onToggle={toggle}>{S.hm.moreHeading}</GroupToggle></h3>
      {open && (nowView ? <HomeMore view={nowView} onOpen={onOpen} onOpenTicket={onOpenTicket} liveTickets={liveTickets} onGo={onGo} /> : <p className="muted">{S.loading}</p>)}
    </section>
  );
}
