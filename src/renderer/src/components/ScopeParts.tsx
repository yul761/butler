// 范围页（epic / feature）共用的展示件：只吃 props，不调 api。
import type { ScopeTurnRow, Turn } from "../../../shared/turn";
import { barSegments } from "../home-view";
import { whoLabel } from "../scope-view";
import { S } from "../strings";
import { turnTone } from "../turn-tone";

export function WhoTag({ turn }: { turn: Turn }) {
  return <span className={`who turn-tag turn-${turnTone(turn)}`}>{whoLabel(turn, S)}</span>;
}

export function ScopeBar({ bar, total }: { bar: ScopeTurnRow["bar"]; total: number }) {
  const segs = barSegments(bar, total);
  if (segs.length === 0) return null;
  return <div className="turn-bar">{segs.map((s) => <i key={s.tone} className={`turn-${s.tone}`} style={{ width: `${s.pct}%` }} />)}</div>;
}
