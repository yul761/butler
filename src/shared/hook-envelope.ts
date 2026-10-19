export interface HookEnvelope {
  v: 1;
  receivedAt: number;
  /** Butler 启动 claude 时注入的 BUTLER_TICKET。 */
  ticket: string | null;
  /** Butler 启动 claude 时注入的 BUTLER_SESSION（启动该终端时用的 session id，/clear 后不变）。 */
  butlerSession: string | null;
  /** Claude Code 通过 stdin 传给 hook 的 JSON。 */
  payload: unknown;
  parseError?: string;
  raw?: string;
}

export function parseEnvelope(text: string): HookEnvelope | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || v.v !== 1 || typeof v.receivedAt !== "number") return null;
  return {
    v: 1,
    receivedAt: v.receivedAt,
    ticket: typeof v.ticket === "string" ? v.ticket : null,
    butlerSession: typeof v.butlerSession === "string" ? v.butlerSession : null,
    payload: v.payload ?? null,
    ...(typeof v.parseError === "string" ? { parseError: v.parseError } : {}),
    ...(typeof v.raw === "string" ? { raw: v.raw } : {}),
  };
}
