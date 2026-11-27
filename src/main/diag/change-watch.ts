/**
 * 定时看一样东西变没变，变了才通知（BTL-275）。原来栈的 tick 每分钟无条件发一次 data notify，
 * 顺带让按时间出现的提醒（comment loop 的「超过 30 分钟没送到」等）一分钟内出现在界面上；去掉之后用它看「现在」页的提醒。
 * 创建时马上记下基线（启动时的状态），不通知：要是等第一次定时检查才记，启动后第一分钟里新出现的提醒会被当成基线吞掉，
 * 之后一直不变就永远不通知。创建时读出错就留到第一次检查再记基线。读的时候出错当作没变，下次再看。
 */
export function changeWatcher(read: () => unknown, changed: () => void): () => void {
  const snapshot = (): string | null => {
    try {
      return JSON.stringify(read()) ?? "";
    } catch {
      return null;
    }
  };
  let last = snapshot();
  return () => {
    const now = snapshot();
    if (now === null) return;
    if (last !== null && now !== last) changed();
    last = now;
  };
}

/** 兜底刷新的间隔（BTL-275 审查）：有的写入没发 notify，原来靠栈 tick 每分钟一次盖住；现在最多 10 分钟一次。 */
export const BACKSTOP_REFRESH_MS = 10 * 60_000;

/**
 * 每分钟一次的检查（BTL-275）：「现在」页的提醒变了、本地日期变了（看板的「今天合并」按 dayStart 算，过了午夜要翻篇）、
 * 离上次发已经过了 backstopMs，任何一个满足就发一次 notify（一次检查最多一次）。
 * notify 走 Invalidator：窗口藏着时照旧攒着，回来时补发，所以这里不看窗口。
 */
export function minuteRefresh(d: {
  notices: () => unknown;
  day: () => string;
  now: () => number;
  notify: () => void;
  backstopMs?: number;
}): () => void {
  const backstopMs = d.backstopMs ?? BACKSTOP_REFRESH_MS;
  let due = false;
  const notices = changeWatcher(d.notices, () => (due = true));
  const day = changeWatcher(d.day, () => (due = true));
  let last = d.now();
  return () => {
    due = false;
    notices();
    day();
    const t = d.now();
    if (!due && t - last < backstopMs) return;
    last = t;
    d.notify();
  };
}
