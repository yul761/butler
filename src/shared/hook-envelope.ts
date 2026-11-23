export interface HookEnvelope {
  v: 1;
  receivedAt: number;
  /** Shipherd 启动 claude 时注入的 SHIPHERD_TICKET。 */
  ticket: string | null;
  /** Shipherd 启动 claude 时注入的 SHIPHERD_SESSION（启动该终端时用的 session id，/clear 后不变）。 */
  shipherdSession: string | null;
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
    shipherdSession: typeof v.shipherdSession === "string" ? v.shipherdSession : null,
    payload: v.payload ?? null,
    ...(typeof v.parseError === "string" ? { parseError: v.parseError } : {}),
    ...(typeof v.raw === "string" ? { raw: v.raw } : {}),
  };
}

/** Shipherd 自己启动的 headless claude 用这个前缀作 SHIPHERD_SESSION；它们的 hook 上报全部忽略。 */
export const HEADLESS_SESSION_PREFIX = "headless:";

export function isHeadlessEnvelope(env: HookEnvelope): boolean {
  return env.shipherdSession?.startsWith(HEADLESS_SESSION_PREFIX) ?? false;
}
