/** 判断（「需要你」、卡住）给的理由最多多少个字符：界面上只占一行。 */
export const JUDGE_REASON_CHARS = 80;

/** 像标签的东西：`<reason>`、`</invoke>`。不带属性、紧跟 `>` 的才算，`a<b` 这样的比较不算。 */
const TAG_RE = /<\/?[A-Za-z_][\w-]*>/;

/**
 * 模型的答案里有时混进工具调用的标签（真机检查：Haiku 的理由结尾是 "</reason>\n</invoke>\n"）：
 * 从第一个标签起连同后面的全部丢掉。其余原样，不压空白、不截长度。
 */
export function stripModelTags(text: string): string {
  const m = TAG_RE.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/** 判断给的理由、建议：去掉标签和它后面的内容，空白压成一个空格，去掉首尾空白，最多 80 个字符（不切开代理对）。 */
export function sanitizeJudgeReason(text: string): string {
  const flat = stripModelTags(text).replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= JUDGE_REASON_CHARS ? flat : chars.slice(0, JUDGE_REASON_CHARS).join("").trimEnd();
}
