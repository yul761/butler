// 范围页（epic / feature）共用的展示件：只吃 props，不调 api。
import { Fragment, type ReactNode } from "react";
import type { ScopeTurnRow, Turn, TurnBoard, TurnItem } from "../../../shared/turn";
import { barSegments, cardKey, type RunningRow } from "../home-view";
import { progressLine, scopeRowLine, slowestLine, whoLabel, type TicketRow } from "../scope-view";
import { S } from "../strings";
import { turnSentence } from "../turn-text";
import { turnTone } from "../turn-tone";
import { TurnCard, type TurnCardProps } from "./TurnCard";
import type { TurnBoardState } from "./useTurnBoard";

export function WhoTag({ turn }: { turn: Turn }) {
  return <span className={`who turn-tag turn-${turnTone(turn)}`}>{whoLabel(turn, S)}</span>;
}

export function ScopeBar({ bar, total }: { bar: ScopeTurnRow["bar"]; total: number }) {
  const segs = barSegments(bar, total);
  if (segs.length === 0) return null;
  return <div className="turn-bar">{segs.map((s) => <i key={s.tone} className={`turn-${s.tone}`} style={{ width: `${s.pct}%` }} />)}</div>;
}

/** 「进行中」的一行：首页和范围页共用。 */
export function RunRow({ row, onOpenTicket }: { row: RunningRow; onOpenTicket: (key: string) => void }) {
  return (
    <button className="home-run" disabled={row.ticketKey === null} onClick={() => row.ticketKey !== null && onOpenTicket(row.ticketKey)}>
      <span className="key">{row.ticketKey ?? ""}</span>
      <span className={`turn-tag turn-${row.owner}`}>{row.who}</span>
      <span className="sentence">{row.sentence}</span>
      <span className="age muted">{row.age}</span>
    </button>
  );
}

export function ScopeOverview(p: {
  rows: ScopeTurnRow[]; total: ScopeTurnRow | null; youItems: TurnItem[]; kind: "epic" | "feature"; emptyText: string;
  cards: Omit<TurnCardProps, "item">; onOpenRow?: (id: number | string) => void; onCreate?: () => void;
  /** feature 页：有 PR 的 ticket（ticketsWithPr）。没有 PR 的 ticket 行写「还没开 PR」，不写「0/1 合了」。 */
  ticketsWithPr?: ReadonlySet<string>;
}) {
  const you = (
    <section className="scope-you">
      <h3>{S.lay.youHere}</h3>
      {p.youItems.length === 0 ? <p className="muted">{S.lay.noYouHere}</p> : p.youItems.map((item) => <TurnCard key={cardKey(item)} item={item} {...p.cards} />)}
    </section>
  );
  // 有 feature 但还没有 ticket 时 total 是 0，feature 行仍要显示。
  // 还没有 ticket 也可能轮到你（总控问了一句）：页签标着要你看，卡片就得在这里。
  if (p.total === null || (p.total.total === 0 && p.rows.length === 0)) {
    return (
      <div className="scope-overview">
        <p className="muted">{p.emptyText}</p>
        {p.onCreate && <button className="primary" onClick={p.onCreate}>{p.kind === "epic" ? S.newFeature : S.newTicket}</button>}
        {p.youItems.length > 0 && you}
      </div>
    );
  }
  return (
    <div className="scope-overview">
      <p className="scope-progress">{progressLine(p.total, S)}</p>
      <p className="muted">{slowestLine(p.total.slowest, S)}</p>
      {you}
      {p.rows.length > 0 && (
        <section className="scope-rows">
          {p.kind === "epic" && <h3>{S.lay.featuresHeading}</h3>}
          {p.rows.map((r) => (
            <div key={`${r.kind}:${r.id}`} className="scope-row">
              <button className="name" title={r.name} onClick={() => p.onOpenRow?.(r.id)}>{r.name}</button>
              <span className="line muted">{scopeRowLine(r, p.ticketsWithPr, S)}</span>
              <ScopeBar bar={r.bar} total={r.total} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export function ScopeRunning(p: { rows: RunningRow[]; onOpenTicket: (key: string) => void }) {
  if (p.rows.length === 0) return <p className="muted">{S.lay.runningEmpty}</p>;
  return <section className="home-running">{p.rows.map((r) => <RunRow key={r.key} row={r} onOpenTicket={p.onOpenTicket} />)}</section>;
}

export function ScopeTicketTable(p: {
  groups: { name: string | null; merged: number; total: number; rows: TicketRow[] }[];
  onOpenTicket: (key: string) => void; emptyText: string;
}) {
  if (p.groups.length === 0) return <p className="muted">{p.emptyText}</p>;
  return (
    <table className="ticket-table">
      <thead>
        <tr><th>{S.lay.colTicket}</th><th>{S.lay.colWho}</th><th>{S.lay.colNow}</th><th>{S.lay.colPr}</th></tr>
      </thead>
      <tbody>
        {p.groups.map((g, n) => (
          <Fragment key={g.name ?? n}>
            {g.name !== null && <tr className="group-row"><th colSpan={4}>{S.lay.groupHeader(g.name, g.merged, g.total)}</th></tr>}
            {g.rows.length === 0 && <tr><td colSpan={4} className="muted">{S.lay.noTicketsInGroup}</td></tr>}
            {g.rows.map((r) => (
              // 点这一行哪儿都去 ticket 页；ticket 号是按钮，键盘 Tab 到它按回车也行（点击冒泡到这一行）。
              <tr key={r.key} onClick={() => p.onOpenTicket(r.key)}>
                <td><button type="button" className="key">{r.key}</button>{r.title && <span className="muted"> {r.title}</span>}</td>
                <td><WhoTag turn={r.turn} /></td>
                <td>{turnSentence(r.turn, r.item, S)}{r.others > 0 && <span className="muted"> · {S.lay.morePrs(r.others)}</span>}</td>
                <td>{r.prs.length === 0 ? "—" : r.prs.map((x) => x.tag).join(" ")}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

export function ControlSplit(p: { left: ReactNode; right: ReactNode }) {
  return <div className="control-split"><div className="control-left">{p.left}</div><div className="control-right">{p.right}</div></div>;
}

/** 范围页的页签内容要看板：还没取到时是骨架（不闪空状态）；取不到就说为什么（board-error：和页面的 .error 分开，不会同时被找到）。 */
export function ScopeBoard({ turn, children }: { turn: Pick<TurnBoardState, "board" | "error">; children: (b: TurnBoard) => ReactNode }) {
  if (turn.board !== null) return <>{children(turn.board)}</>;
  if (turn.error !== null) return <p className="board-error">{turn.error}</p>;
  return <div className="scope-overview" aria-busy="true"><p className="muted">…</p></div>;
}
