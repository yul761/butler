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
  return flat.length > limit ? flat.slice(0, limit) : flat;
}
