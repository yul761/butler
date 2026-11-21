// 全部工作（UI 重做第 2 层，spec §5.3）：新建按钮、「已归档」「未认领 session」两个入口，下面一张表——名字、谁该动、现在怎么样、进度。
// 「更多」里是原来进度页上的栈、自动接活和待 review（第 3 层补回）。
// 状态全部来自 turn:board 的 scopes，这里只排序和显示；没有统计的行写「—」。
import { useState } from "react";
import type { ScopeTurnRow, TurnBoard } from "../../../shared/turn";
import type { FeatureView, TicketView } from "../../../shared/types";
import type { Route } from "../App";
import { barSegments, scopeLine, scopeRoute, scopeWho, ticketNowText, ticketWhoTurn } from "../home-view";
import { S } from "../strings";
import { GroupToggle } from "./HomeMore";
import { IntakeQueue } from "./IntakeQueue";
import { ReviewQueue } from "./ReviewQueue";
import { WhoTag } from "./ScopeParts";
import { ManagedStacks } from "./StacksPanel";
import { useStateRefetch } from "./useStateRefetch";
import { api } from "../api";

export interface AllWorkBodyProps {
  board: TurnBoard | null;
  features: FeatureView[];
  /** 单独的 ticket（不在任何 feature 里）。 */
  tickets: TicketView[];
  unclaimedCount: number;
  /** 「显示 Butler 之外开的 session」开着才有「未认领 session」入口（BTL-244，默认关）。 */
  showUnclaimed?: boolean;
  now: number;
  /** 从提醒跳来：「更多」默认展开。 */
  focusMore?: "stacks" | "intake";
  onNewTicket: () => void;
  onNewFeature: () => void;
  onGo: (r: Route) => void;
  onOpenTicket: (key: string) => void;
}

/** title：ticket 的标题（name 是 key 加标题，用来排序和 title 提示）；feature 为 null。 */
interface Row { kind: ScopeTurnRow["kind"]; id: number | string; name: string; title: string | null; scope: ScopeTurnRow | null }

const DASH = "—";

function rowsOf(p: AllWorkBodyProps): Row[] {
  const scopes = new Map((p.board?.scopes ?? []).map((s) => [`${s.kind}:${s.id}`, s]));
  const row = (kind: Row["kind"], id: number | string, name: string, title: string | null = null): Row => ({ kind, id, name, title, scope: scopes.get(`${kind}:${id}`) ?? null });
  const rows = [
    ...p.features.map((f) => row("feature", f.id, f.name)),
    ...p.tickets.map((t) => row("ticket", t.key, t.title ? `${t.key} ${t.title}` : t.key, t.title || null)),
  ];
  // 轮到你多的在前，再按名字。
  return rows.sort((a, b) => (b.scope?.youCount ?? 0) - (a.scope?.youCount ?? 0) || a.name.localeCompare(b.name));
}

export function AllWorkBody(p: AllWorkBodyProps) {
  const [moreOpen, setMoreOpen] = useState(p.focusMore !== undefined);
  const rows = rowsOf(p);
  /** 单独的 ticket 写它自己的状态（ticketNowText）；feature 写合了几个、最慢的是谁。 */
  const nowText = (r: Row, s: ScopeTurnRow | null): string => {
    if (r.kind === "ticket") return ticketNowText(p.board?.items ?? [], s, String(r.id), S);
    return s ? scopeLine(s, S) : DASH;
  };
  /** 谁该动：单独的 ticket 按它自己的轮次（同首页「进行中」、范围页的表格）；feature 按汇总行。 */
  const whoCell = (r: Row, s: ScopeTurnRow | null) => {
    if (r.kind === "ticket") {
      const t = ticketWhoTurn(p.board?.items ?? [], s, String(r.id));
      return t ? <WhoTag turn={t} /> : DASH;
    }
    const who = s ? scopeWho(s, S) : null;
    return who ? <span className={`turn-tag turn-${who.tone ?? "idle"}`}>{who.text}</span> : DASH;
  };
  const open = (r: Row) => (r.kind === "ticket" ? p.onOpenTicket(String(r.id)) : p.onGo(scopeRoute({ kind: r.kind, id: r.id } as ScopeTurnRow)));
  return (
    <div className="page all-work">
      <header>
        <h2>{S.allWork}</h2>
        <p className="muted">{S.hm.all.lede(p.features.length, p.tickets.length)}</p>
      </header>
      <div className="actions all-work-actions">
        <button onClick={p.onNewTicket}>+ {S.newTicket}</button>
        <button onClick={p.onNewFeature}>+ {S.newFeature}</button>
        <span className="spacer" />
        <button onClick={() => p.onGo({ page: "archived" })}>{S.archived}</button>
        {p.showUnclaimed && <button onClick={() => p.onGo({ page: "unclaimed" })}>{S.hm.all.unclaimedBtn(p.unclaimedCount)}</button>}
      </div>
      {rows.length === 0 ? <p className="muted">{S.hm.all.empty}</p> : (
        <table className="all-work-table">
          <thead>
            <tr><th>{S.hm.all.colName}</th><th>{S.hm.all.colWho}</th><th>{S.hm.all.colNow}</th><th>{S.hm.all.colProgress}</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = r.scope;
              const bar = s ? barSegments(s.bar, s.total) : [];
              return (
                <tr key={`${r.kind}:${r.id}`} data-testid={`all-work-row-${r.kind}-${r.id}`}>
                  <td className="name"><button className="row-name" title={r.name} aria-label={r.name} onClick={() => open(r)}>
                    {r.kind === "ticket" ? <><span className="key">{r.id}</span>{r.title && <span className="title">{r.title}</span>}</> : <span className="title">{r.name}</span>}
                  </button></td>
                  <td>{whoCell(r, s)}</td>
                  <td>{nowText(r, s)}</td>
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
            <ManagedStacks filter={{ featureId: null }} onOpenTicket={p.onOpenTicket} />
            <IntakeQueue onOpenTicket={p.onOpenTicket} />
            <ReviewQueue onOpenTicket={p.onOpenTicket} />
          </>
        )}
      </section>
    </div>
  );
}

/** App 用的入口；现在就是 AllWorkBody。 */
export function AllWorkPage(p: AllWorkBodyProps) {
  // 入口跟着设置走：改了设置会发 stateChanged，这里跟着重取。
  const settings = useStateRefetch("settings:all-work", api.settings);
  return <AllWorkBody {...p} showUnclaimed={settings?.showOutsideSessions === "1"} />;
}
