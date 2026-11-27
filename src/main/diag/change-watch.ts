/**
 * 定时看一样东西变没变，变了才通知（BTL-275）。原来栈的 tick 每分钟无条件发一次 data notify，
 * 顺带让按时间出现的提醒（comment loop 的「超过 30 分钟没送到」等）一分钟内出现在界面上；去掉之后用它看「现在」页的提醒。
 * 第一次只记下基线，不通知（界面启动时已经读过）。读的时候出错当作没变，下次再看。
 */
export function changeWatcher(read: () => unknown, changed: () => void): () => void {
  let last: string | null = null;
  return () => {
    let now: string;
    try {
      now = JSON.stringify(read()) ?? "";
    } catch {
      return;
    }
    if (last !== null && now !== last) changed();
    last = now;
  };
}
