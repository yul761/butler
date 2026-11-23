// 范围页（epic，内部是 feature）的展示件：只吃 props，不调 api。
import { Fragment, useState, type ReactNode } from "react";
import { isCollapsed, setCollapsed } from "../local-prefs";
import type { ScopeTurnRow, Turn, TurnBoard, TurnItem } from "../../../shared/turn";
import { barSegments, cardKey, type RunningRow } from "../home-view";
import { progressLine, scopeRowLine, slowestLine, whoLabel, type BlockGroup, type TicketRow } from "../scope-view";
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
  rows: ScopeTurnRow[]; total: ScopeTurnRow | null; youItems: TurnItem[]; kind: "feature"; emptyText: string;
  cards: Omit<TurnCardProps, "item">; onOpenRow?: (id: number | string) => void; onCreate?: () => void;
  /** feature 页：有 PR 的 ticket（ticketsWithPr）。没有 PR 的 ticket 行写「还没开 PR」，不写「0/1 合了」。 */
  ticketsWithPr?: ReadonlySet<string>;
  /** epic 页：epic 里的 feature（blockGroups）。有 feature 时按 feature 一组一行，代替 ticket 行。 */
  blocks?: BlockGroup[];
  onOpenTicket?: (key: string) => void;
}) {
  const you = (
    <section className="scope-you">
      <h3>{S.lay.youHere}</h3>
      {p.youItems.length === 0 ? <p className="muted">{S.lay.noYouHere}</p> : p.youItems.map((item) => <TurnCard key={cardKey(item)} item={item} {...p.cards} />)}
    </section>
  );
  // 下面的行还没有统计时 total 是 0，行仍要显示。
  // 还没有 ticket 也可能轮到你（总控问了一句）：页签标着要你看，卡片就得在这里。
  if (p.total === null || (p.total.total === 0 && p.rows.length === 0)) {
    return (
      <div className="scope-overview">
        <p className="muted">{p.emptyText}</p>
        {p.onCreate && <button className="primary" onClick={p.onCreate}>{S.newTicket}</button>}
        {p.youItems.length > 0 && you}
      </div>
    );
  }
  return (
    <div className="scope-overview">
      <p className="scope-progress">{progressLine(p.total, S)}</p>
      <p className="muted">{slowestLine(p.total.slowest, S)}</p>
      {you}
      {p.blocks && p.blocks.some((g) => g.id !== null) ? (
        <ScopeBlocks groups={p.blocks} onOpenTicket={p.onOpenTicket ?? (() => {})} />
      ) : p.rows.length > 0 && (
        <section className="scope-rows">
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

/** epic 里的 feature：按顺序一行一个，可以展开看它的 ticket（同「全部 ticket」的列）。第一个还没合完的默认展开。 */
export function ScopeBlocks(p: { groups: BlockGroup[]; onOpenTicket: (key: string) => void }) {
  const firstOpen = p.groups.find((g) => g.id !== null && g.merged < g.total) ?? null;
  return (
    <section className="scope-blocks">
      <h3>{S.lay.featuresHeading}</h3>
      <p className="muted">{S.lay.featuresHint}</p>
      {p.groups.map((g) => (
        <details key={g.id ?? "none"} className="scope-block" data-block={g.id ?? "none"} open={g === firstOpen || undefined}>
          <summary title={g.description ?? undefined}>
            <span className="name">{g.name}</span>
            <span className="line muted">{S.lay.featureCard(g.merged, g.total)}</span>
          </summary>
          <ScopeTicketTable groups={[{ ...g, name: null }]} onOpenTicket={p.onOpenTicket} emptyText={S.lay.noTicketsInGroup} />
        </details>
      ))}
    </section>
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

/**
 * 「总控」页签：上面一句说明（lede，可不给），下面左终端、右对话。
 * 分栏线上有个按钮把右栏收起来（左边终端占满），再点展开；`page` 是页面种类（epic / feature / shipherd），各记各的。
 * 终端靠自己的 ResizeObserver 重新 fit，这里不用管。
 */
export function ControlSplit(p: { lede?: string; left: ReactNode; right: ReactNode; page?: string }) {
  const id = `control-right:${p.page ?? "default"}`;
  const [folded, setFolded] = useState(() => isCollapsed(id));
  const toggle = () => {
    setFolded(!folded);
    setCollapsed(id, !folded);
  };
  return (
    <>
      {p.lede && <p className="muted control-lede">{p.lede}</p>}
      <div className={`control-split${folded ? " right-folded" : ""}`}>
        <div className="control-left">{p.left}</div>
        <button
          type="button"
          className="control-fold"
          aria-expanded={!folded}
          title={folded ? S.lay.ctlExpand : S.lay.ctlCollapse}
          aria-label={folded ? S.lay.ctlExpand : S.lay.ctlCollapse}
          onClick={toggle}
        >
          {folded ? "‹" : "›"}
        </button>
        <div className="control-right">{p.right}</div>
      </div>
    </>
  );
}

/** 范围页的页签内容要看板：还没取到时是骨架（不闪空状态）；取不到就说为什么（board-error：和页面的 .error 分开，不会同时被找到）。 */
export function ScopeBoard({ turn, children }: { turn: Pick<TurnBoardState, "board" | "error">; children: (b: TurnBoard) => ReactNode }) {
  if (turn.board !== null) return <>{children(turn.board)}</>;
  if (turn.error !== null) return <p className="board-error">{turn.error}</p>;
  return <div className="scope-overview" aria-busy="true"><p className="muted">…</p></div>;
}
