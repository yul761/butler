// 全部工作（UI 重做第 2 层，spec §5.3）：新建按钮、「已归档」「未认领 session」两个入口，下面一张表——名字、谁该动、现在怎么样、进度。
// 状态全部来自 turn:board 的 scopes，这里只排序和显示；没有统计的行写「—」。
import { useState } from "react";
import type { ScopeTurnRow, TurnBoard } from "../../../shared/turn";
import type { EpicView, FeatureView, TicketView } from "../../../shared/types";
import type { Route } from "../App";
import { barSegments, scopeLine, scopeRoute, scopeWho } from "../home-view";
import { S } from "../strings";
import { featuresOutsideEpics } from "./epic-row";
import { GroupToggle } from "./HomeMore";
import { IntakeQueue } from "./IntakeQueue";
import { ManagedStacks } from "./StacksPanel";

export interface AllWorkBodyProps {
  board: TurnBoard | null;
  epics: EpicView[];
  features: FeatureView[];
  /** 单独的 ticket（不在任何 feature 里）。 */
  tickets: TicketView[];
  unclaimedCount: number;
  now: number;
  /** 从提醒跳来：「栈与自动接活」默认展开。 */
  focusMore?: "stacks" | "intake";
  onNewTicket: () => void;
  onNewFeature: () => void;
  onNewEpic: () => void;
  onGo: (r: Route) => void;
  onOpenTicket: (key: string) => void;
}

interface Row { kind: ScopeTurnRow["kind"]; id: number | string; name: string; scope: ScopeTurnRow | null }

const DASH = "—";

function rowsOf(p: AllWorkBodyProps): Row[] {
  const scopes = new Map((p.board?.scopes ?? []).map((s) => [`${s.kind}:${s.id}`, s]));
  const row = (kind: Row["kind"], id: number | string, name: string): Row => ({ kind, id, name, scope: scopes.get(`${kind}:${id}`) ?? null });
  const rows = [
    ...p.epics.map((e) => row("epic", e.id, e.name)),
    ...featuresOutsideEpics(p.features, p.epics).map((f) => row("feature", f.id, f.name)),
    ...p.tickets.map((t) => row("ticket", t.key, t.title ? `${t.key} ${t.title}` : t.key)),
  ];
  // 轮到你多的在前，再按名字。
  return rows.sort((a, b) => (b.scope?.youCount ?? 0) - (a.scope?.youCount ?? 0) || a.name.localeCompare(b.name));
}

export function AllWorkBody(p: AllWorkBodyProps) {
  const [moreOpen, setMoreOpen] = useState(p.focusMore !== undefined);
  const rows = rowsOf(p);
  const open = (r: Row) => (r.kind === "ticket" ? p.onOpenTicket(String(r.id)) : p.onGo(scopeRoute({ kind: r.kind, id: r.id } as ScopeTurnRow)));
  return (
    <div className="page all-work">
      <header>
        <h2>{S.allWork}</h2>
        <p className="muted">{S.hm.all.lede(p.epics.length, p.tickets.length)}</p>
      </header>
      <div className="actions all-work-actions">
        <button onClick={p.onNewTicket}>+ {S.newTicket}</button>
        <button onClick={p.onNewFeature}>+ {S.newFeature}</button>
        <button onClick={p.onNewEpic}>+ {S.newEpic}</button>
        <span className="spacer" />
        <button onClick={() => p.onGo({ page: "archived" })}>{S.archived}</button>
        <button onClick={() => p.onGo({ page: "unclaimed" })}>{S.hm.all.unclaimedBtn(p.unclaimedCount)}</button>
      </div>
      {rows.length === 0 ? <p className="muted">{S.hm.all.empty}</p> : (
        <table className="all-work-table">
          <thead>
            <tr><th>{S.hm.all.colName}</th><th>{S.hm.all.colWho}</th><th>{S.hm.all.colNow}</th><th>{S.hm.all.colProgress}</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = r.scope;
              const who = s ? scopeWho(s, S) : null;
              const bar = s ? barSegments(s.bar, s.total) : [];
              return (
                <tr key={`${r.kind}:${r.id}`} data-testid={`all-work-row-${r.kind}-${r.id}`}>
                  <td className="name"><button className="row-name" title={r.name} onClick={() => open(r)}>{r.name}</button></td>
                  <td>{who ? <span className={`turn-tag turn-${who.tone ?? "idle"}`}>{who.text}</span> : DASH}</td>
                  <td>{s ? scopeLine(s, S) : DASH}</td>
                  <td>
                    {s && bar.length > 0 ? (
                      <div className="turn-bar">{bar.map((b) => <i key={b.tone} className={`turn-${b.tone}`} style={{ width: `${b.pct}%` }} />)}</div>
                    ) : DASH}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <section className="all-work-more">
        <h3><GroupToggle open={moreOpen} onToggle={() => setMoreOpen((o) => !o)}>{S.hm.all.moreHeading}</GroupToggle></h3>
        {moreOpen && (
          <>
            <ManagedStacks filter={{ epicId: null, featureId: null }} onOpenTicket={p.onOpenTicket} />
            <IntakeQueue onOpenTicket={p.onOpenTicket} />
          </>
        )}
      </section>
    </div>
  );
}

/** App 用的入口；现在就是 AllWorkBody。 */
export function AllWorkPage(p: AllWorkBodyProps) {
  return <AllWorkBody {...p} />;
}
