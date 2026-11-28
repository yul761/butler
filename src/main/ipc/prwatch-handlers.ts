import type { WatchedPr } from "../../shared/types";
import type { PrWatcher } from "../prwatch/pr-watcher";
import { ticketKeyArg } from "./validate";

interface Deps {
  watcher: Pick<PrWatcher, "statusOf" | "statusOfMany">;
  /** 全量读取时要看的 ticket。 */
  ticketKeys: () => string[];
}

/**
 * prwatch:list（BTL-270 审查）：不带参数是所有 ticket 的（批量查询）；带了 ticketKey 只读这一个 ticket 的（关着的 ticket 页上的「关掉剩下的 PR」）。
 * 带了参数却不是合法的 ticket key（null、数字、空串、超长）就拒，不当成不带参数去读全部。
 */
export function prWatchListHandler(d: Deps): (raw: unknown) => WatchedPr[] {
  return (raw) => {
    if (raw === undefined) return [...d.watcher.statusOfMany(d.ticketKeys()).values()].flat();
    return d.watcher.statusOf(ticketKeyArg(raw));
  };
}
