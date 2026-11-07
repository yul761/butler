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
