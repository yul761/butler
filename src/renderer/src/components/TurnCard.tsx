// 首页的一张「轮到你」卡片（UI 重做第 2 层，spec §5.3）：类型标签、一句话（第 1 层的 turnSentence）、位置和多久、一到三个按钮。
// Shipherd 要你点一下的那类直接放原来的 Notice，按钮也是它自己的。
import { memo, useState } from "react";
import type { TurnItem } from "../../../shared/turn";
import type { NowTarget } from "../../../shared/types";
import { api } from "../api";
import type { Route } from "../App";
import { reportError } from "../errors";
import { cardActions, locationOf, lookTarget, turnTone, type CardAction, type NameCtx } from "../home-view";
import { S } from "../strings";
import { runCardAction } from "../turn-card-actions";
import { turnSentence } from "../turn-text";
import { Notice } from "./Notice";

export interface TurnCardProps {
  item: TurnItem;
  ctx: NameCtx;
  now: number;
  /** 开修复 session 并导航由 App 做，失败也由 App 报。 */
  onFix: (featureId: number, sessionId: string) => void;
  /** 「去看看」和 Notice 的打开：落到那一页的那个 session。 */
  onOpen: (t: NowTarget) => void;
  onGo: (r: Route) => void;
  /** 回答、送出之后让首页重取。 */
  onChanged: () => void;
}

/** memo（BTL-277）：board 按结构留旧引用、App 的回调稳定，别的卡片变了这张不重画。 */
export const TurnCard = memo(function TurnCard({ item, ctx, now, onFix, onOpen, onGo, onChanged }: TurnCardProps) {
  const t = item.turn;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  if (t.owner !== "you") return null;
  const { path, scope, key, age } = locationOf(item, ctx, now, S);
  const shipherd = t.kind === "shipherd";
  // 不挂在任何地方的 Shipherd 提醒没有位置可写。
  const where = shipherd && item.ticketKey === null && item.featureId === null ? "" : path;
  const target = lookTarget(item);
  const actions = cardActions(item).filter((a) => a.id !== "look" || target !== null);

  const act = (a: CardAction) => {
    setBusy(true);
    setResult(null);
    runCardAction(a, item, { ...api, onOpen, onGo, onFix, onChanged }, S)
      .then((r) => {
        if (r === null) return;
        if ("answered" in r) setAnswered(r.answered);
        else setResult(r.message);
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="turn-card" data-testid="turn-card" data-kind={t.kind}>
      <span className={`turn-tag turn-${turnTone(t)}`}>{S.hm.kind[t.kind]}</span>
      <div className="turn-card-body">
        {shipherd ? <Notice notice={t.notice} now={now} onOpen={onOpen} onGo={onGo} /> : <p className="sentence">{turnSentence(t, item, S)}</p>}
        {t.kind === "stuck" && t.action && <p className="stuck-action">{S.hm.stuckAction(t.action)}</p>}
        {(where || age) && (
          <p className="where muted">
            {where && <span className="path" title={where}><span className="scope">{scope}</span>{key !== null && <span className="key">{key}</span>}</span>}
            {age && <span className="age">{age}</span>}
          </p>
        )}
        {result && <p className="muted" role="status">{result}</p>}
      </div>
      {!shipherd && (
        <div className="actions">
          {answered !== null ? <span className="muted" role="status">{S.hm.act.answered(answered)}</span> : actions.map((a) => (
            <button key={a.id === "answer" ? `answer:${a.option}` : a.id} className={a.primary ? "primary" : undefined} disabled={busy} onClick={() => act(a)}>
              {a.id === "answer" ? a.option : S.hm.act[a.id]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
