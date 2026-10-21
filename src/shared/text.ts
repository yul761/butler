/** C0 控制字符（含换行、Tab、ESC）、DEL 和 C1 控制字符。 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export const PREFILL_LIMIT = 500;

/** 去掉所有控制字符：要写进终端的外部文本（例如文件名）里不能带 ESC 序列或回车。 */
export function stripControl(text: string): string {
  return text.replace(CONTROL_RE, "");
}

/**
 * 预填到 claude 输入框的文本：换行和 Tab 变成空格，其他控制字符去掉，压缩空白，限制长度。
 * 这样写进 PTY 的永远是一行，不会被当成“回车发送”。
 */
export function sanitizePrefill(text: string, limit = PREFILL_LIMIT): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(CONTROL_RE, "").replace(/ {2,}/g, " ").trim();
  if (flat.length <= limit) return flat;
  // 不切进代理对：末尾是高代理项时少留一个单元，否则会变成 U+FFFD。
  const last = flat.charCodeAt(limit - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
  return flat.slice(0, cut).trimEnd();
}

/** 给用户看的时长：不到一秒时用毫秒，免得出现“超过 0 秒”。 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${Math.round(ms / 1000)} 秒`;
}
