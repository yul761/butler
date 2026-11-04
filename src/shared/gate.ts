import type { GateAction } from "./gate-command";

/**
 * 合并总控的闸门（设计文档 2026-11-04）：PreToolUse hook ↔ Butler 主进程，走文件。
 * 请求：<gate>/requests/<id>.json；结果：<gate>/results/<id>.json（同一个 id）。
 * 不引 Node 模块（渲染进程也会打包 shared）。
 */

export const GATE_VERSION = 1;
/** hook 最多等多久拿结果；超时就放行（闸门挂了不能卡住用户）。 */
export const GATE_WAIT_MS = 5000;
/** 请求里任何字符串的长度上限。 */
const STRING_LIMIT = 4096;

export type GateRequest =
  | { v: 1; phase: "pre"; action: GateAction; cwd: string; session: string | null; ticket: string | null }
  | { v: 1; phase: "post"; action: GateAction; cwd: string; session: string | null; ticket: string | null };

export type GateResult = { v: 1; decision: "allow" } | { v: 1; decision: "deny"; reason: string };

const okStr = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= STRING_LIMIT;
const okNullable = (x: unknown): x is string | null => x === null || okStr(x);

/** 不用 node:path：POSIX 的 /…，Windows 的 C:\… 、C:/… 和 \\server\…。 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

function parseAction(raw: unknown): GateAction | null {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object" || !okNullable(a.dir)) return null;
  const dir = a.dir;
  switch (a.kind) {
    case "pr_merge":
      return okNullable(a.pr) ? { kind: "pr_merge", dir, pr: a.pr } : null;
    case "local_merge":
      return okStr(a.source) ? { kind: "local_merge", dir, source: a.source } : null;
    case "push":
      if (!okStr(a.target) || (a.source !== undefined && !okStr(a.source))) return null;
      return a.source === undefined ? { kind: "push", dir, target: a.target } : { kind: "push", dir, target: a.target, source: a.source };
    case "switch":
      return okStr(a.branch) && typeof a.create === "boolean" ? { kind: "switch", dir, branch: a.branch, create: a.create } : null;
    default:
      return null;
  }
}

/** 主进程按运行时类型检查请求（文件谁都能写）：不合规返回 null。 */
export function parseGateRequest(raw: unknown): GateRequest | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== GATE_VERSION) return null;
  if (o.phase !== "pre" && o.phase !== "post") return null;
  if (!okStr(o.cwd) || !isAbsolutePath(o.cwd)) return null;
  if (!okNullable(o.session) || !okNullable(o.ticket)) return null;
  const action = parseAction(o.action);
  if (!action) return null;
  return { v: 1, phase: o.phase, action, cwd: o.cwd, session: o.session, ticket: o.ticket };
}
