// state:changed 的范围（BTL-242）：渲染进程按范围决定要不要重取。
//   data：存下来的东西变了（默认，所有原来的 notify 都是它）；
//   activity：在跑的 session 在做什么变了（kind、卡住、撞限）；
//   procs：一次内存采样；
//   messages：留给 BTL-245（session 之间的信箱）；
//   output：在跑的 session 只是又有了输出（最多每 5 秒一次）：只有 ticket 的速览（上下文、最后一句）跟着它重取。
export const STATE_SCOPES = ["data", "activity", "procs", "messages", "output"] as const;
export type StateScope = (typeof STATE_SCOPES)[number];

export interface StateChangedPayload {
  scopes: StateScope[];
}

export const isStateScope = (v: unknown): v is StateScope => typeof v === "string" && (STATE_SCOPES as readonly string[]).includes(v);

/** 读推送过来的参数：旧格式（没有参数）当成 data。 */
export function scopesOf(payload: unknown): StateScope[] {
  const s = (payload as Partial<StateChangedPayload> | undefined)?.scopes;
  if (!Array.isArray(s)) return ["data"];
  const ok = s.filter(isStateScope);
  return ok.length > 0 ? ok : ["data"];
}
