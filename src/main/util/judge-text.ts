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

/**
 * 模型的工具调用、答案字段混进来的标签名：工具调用的 invoke / parameter / function_calls 之类，epic 摘要和判断自己的字段名，
 * 以及带命名空间的（`前缀:名字`，模型工具调用格式用的那种）。
 */
const TOOL_TAG = String.raw`(?:[A-Za-z_][\w-]*:[\w-]+|invoke|parameter|function_calls|function_results|tool_use|tool_result|reason|action|summary|decisions|what|why)`;
const TOOL_CLOSE_RE = new RegExp(String.raw`</${TOOL_TAG}>`);
const TOOL_OPEN_RE = new RegExp(String.raw`<${TOOL_TAG}(?:\s[^<>]*)?>`, "g");

/**
 * 长期保存的文字（epic 摘要）用的窄版（R37）：只认上面这些标签。从第一个闭合的工具标签起连同后面的全部丢掉，开头的工具标签去掉；
 * "Promise<void>"、"<Button>" 这样的代码原样留着。其余不动。
 */
export function stripToolMarkup(text: string): string {
  const m = TOOL_CLOSE_RE.exec(text);
  return (m ? text.slice(0, m.index) : text).replace(TOOL_OPEN_RE, "");
}

/** 判断给的理由、建议：去掉标签和它后面的内容，空白压成一个空格，去掉首尾空白，最多 80 个字符（不切开代理对）。 */
export function sanitizeJudgeReason(text: string): string {
  const flat = stripModelTags(text).replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= JUDGE_REASON_CHARS ? flat : chars.slice(0, JUDGE_REASON_CHARS).join("").trimEnd();
}
