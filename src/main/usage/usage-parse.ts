export interface UsageCounts {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export interface UsageTurn extends UsageCounts {
  messageId: string;
  at: number;
  model: string | null;
  /** input + 全部缓存读写 */
  context: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 把 API 的 usage 对象换算成各类 token 数；不是对象时返回 null（headless 结果也用它） */
export function usageCounts(u: unknown): UsageCounts | null {
  if (!isObj(u)) return null;
  const total = num(u.cache_creation_input_tokens);
  const cc = u.cache_creation;
  let cacheWrite5m: number;
  let cacheWrite1h: number;
  if (isObj(cc)) {
    cacheWrite5m = num(cc.ephemeral_5m_input_tokens);
    cacheWrite1h = num(cc.ephemeral_1h_input_tokens);
  } else {
    // 没有分档信息时，全部按 5 分钟档算
    cacheWrite5m = total;
    cacheWrite1h = 0;
  }
  return {
    input: num(u.input_tokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: num(u.cache_read_input_tokens),
    output: num(u.output_tokens),
  };
}

/** 解析 transcript 的一行；不是带用量的 assistant 行、或没有可用 id 时返回 null */
export function parseUsageLine(line: string): UsageTurn | null {
  // 先快速跳过不相关的行，避免对每行都 JSON.parse
  if (!line.includes('"usage"')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  return usageOfValue(obj);
}

/** 同 parseUsageLine，JSON 已经解析好了（TranscriptHub 每行只解析一次）。 */
export function usageOfValue(obj: unknown): UsageTurn | null {
  if (!isObj(obj) || obj.type !== "assistant") return null;
  const msg = obj.message;
  if (!isObj(msg)) return null;
  const counts = usageCounts(msg.usage);
  if (!counts) return null;
  // 同一个回复拆成多行，id 相同：优先 message.id，其次 requestId
  const messageId =
    typeof msg.id === "string" && msg.id
      ? msg.id
      : typeof obj.requestId === "string" && obj.requestId
        ? obj.requestId
        : null;
  if (!messageId) return null;
  const parsed = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
  return {
    messageId,
    at: Number.isNaN(parsed) ? Date.now() : parsed,
    model: typeof msg.model === "string" ? msg.model : null,
    ...counts,
    context: counts.input + counts.cacheWrite5m + counts.cacheWrite1h + counts.cacheRead,
  };
}

/** 从 at（指向 "{"）起按括号配对找到这个 JSON 对象的结尾（跳过字符串里的括号）；配不上返回 null。 */
function objectAt(text: string, at: number): string | null {
  let depth = 0;
  let str = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (str) {
      if (c === "\\") i++;
      else if (c === '"') str = false;
    } else if (c === '"') str = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(at, i + 1);
  }
  return null;
}

function lastMatch(re: RegExp, ...texts: string[]): RegExpExecArray | null {
  for (const t of texts) {
    let last: RegExpExecArray | null = null;
    for (const m of t.matchAll(re)) last = m;
    if (last) return last;
  }
  return null;
}

/**
 * 太长、没整行解析的 assistant 行（BTL-276：transcript 读取跳过超过 64MB 的行）：从开头、结尾的片段里抠出用量要的字段。
 * Claude Code 写的行里 message 的 model、id 在 content 前面（开头），usage、requestId、type、timestamp 在 content 后面（结尾）；
 * 字符串里的引号是转义过的，「"usage":{」这样的片段只会是真的字段。抠不出来返回 null。
 */
export function usageOfLongLine(head: string, tail: string): UsageTurn | null {
  const isAssistant = /"type"\s*:\s*"assistant"/.test(tail) || /"type"\s*:\s*"assistant"/.test(head);
  if (!isAssistant) return null;
  const u = lastMatch(/"usage"\s*:\s*\{/g, tail, head);
  if (!u) return null;
  const src = u.input === tail ? tail : head;
  const body = objectAt(src, u.index + u[0].length - 1);
  if (!body) return null;
  let usage: unknown;
  try {
    usage = JSON.parse(body);
  } catch {
    return null;
  }
  const str = (m: RegExpExecArray | null): string | undefined => {
    try {
      return m ? (JSON.parse(`"${m[1]}"`) as string) : undefined;
    } catch {
      return undefined;
    }
  };
  const S = '"((?:[^"\\\\]|\\\\.)*)"';
  // message.id：message 对象开头到 content 之前（Claude Code 写的是 {"model":…,"id":…,"type":"message",…,"content":[…]}；content 里 tool_use 的 id 不算）。
  const msgAt = /"message"\s*:\s*\{/.exec(head);
  let msgHead = msgAt ? head.slice(msgAt.index + msgAt[0].length) : "";
  const contentAt = msgHead.search(/"content"\s*:/);
  if (contentAt >= 0) msgHead = msgHead.slice(0, contentAt);
  const id = str(new RegExp(`"id"\\s*:\\s*${S}`).exec(msgHead));
  const requestId = str(lastMatch(new RegExp(`"requestId"\\s*:\\s*${S}`, "g"), tail, head));
  const model = str(new RegExp(`"model"\\s*:\\s*${S}`).exec(head));
  const timestamp = str(lastMatch(new RegExp(`"timestamp"\\s*:\\s*${S}`, "g"), tail, head));
  return usageOfValue({ type: "assistant", requestId, timestamp, message: { id, model, usage } });
}
