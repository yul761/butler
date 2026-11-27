import { useEffect, useState } from "react";
import { api } from "../api";
import { pickableInPreview, restPreviews, restStamp } from "../close-ticket-outcome";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

/**
 * 关着的 ticket 页上的「关掉剩下的 PR」（BTL-270 审查）：还有能勾的才显示。预览要跑 gh：同一个 ticket 短时间里再打开页面用记下的数（restPreviews）。
 * 记下的数配着当时开着的 PR（restStamp，后台监视的记录，不跑 gh，只读这一个 ticket 的）：总控关了 PR、PR 在网页上被关了，对不上就重新预览。
 * 监视记录读不到时照常预览，只是不缓存。只在关着的 ticket 上挂：开着的 ticket 不读监视列表。
 * seq 变了（对话框关上了，TicketPage 已经 settle 过）重新看；关掉了 PR 的，等监视记录跟上（restPreviews.waiting）再预览一次。
 */
export function CloseRestButton({ ticketKey, seq, onOpen }: { ticketKey: string; seq: number; onOpen: () => void }) {
  const watched = useStateRefetch(`rest-watch:${ticketKey}`, () => api.prWatchList(ticketKey).catch(() => "failed" as const));
  // 还没读到监视记录（null）先不预览：读到了才知道 stamp，免得读到前后各预览一次。
  const stamp = watched === null ? undefined : restStamp(watched, ticketKey);
  const [left, setLeft] = useState(0);
  /** 等监视记录跟上时到点再看一次。 */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (stamp === undefined) return;
    const wait = restPreviews.waiting(ticketKey, stamp);
    if (wait > 0) {
      const t = setTimeout(() => setTick((n) => n + 1), wait);
      return () => clearTimeout(t);
    }
    const hit = stamp === null ? undefined : restPreviews.get(ticketKey, stamp);
    if (hit !== undefined) {
      setLeft(hit);
      return;
    }
    let live = true;
    const gen = restPreviews.begin(ticketKey);
    api.closePreview(ticketKey).then(
      (p) => {
        const n = pickableInPreview(p);
        // 预览路上 drop 过（对话框关上了、ticket 被重新打开了）：这个结果是旧的，不写进缓存。stamp 读不到也不写。
        if (stamp !== null) restPreviews.set(ticketKey, n, stamp, gen);
        if (live) setLeft(n);
      },
      () => live && setLeft(0),
    );
    return () => {
      live = false;
    };
  }, [ticketKey, seq, stamp, tick]);
  return left > 0 ? <button className="ticket-close-rest" onClick={onOpen}>{S.tc.closeRest}</button> : null;
}
