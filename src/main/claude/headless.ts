import { execFile, type ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

export const HEADLESS_TIMEOUT_MS = 5 * 60 * 1000;
const STDOUT_LIMIT = 20 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

/** handoff 的只读白名单：读文件、查 PR、看 git 历史。tracker MCP 工具由设置追加。 */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(gh pr view:*)", "Bash(gh pr checks:*)", "Bash(git log:*)", "Bash(git status)"];
/** 不管用户默认的权限模式是什么，这些写工具一律拒绝。 */
export const DENIED_TOOLS = ["Edit", "Write", "NotebookEdit"];

export interface HeadlessRequest {
  claudePath: string;
  args: string[];
  /** 写进 stdin，永远不进 argv。 */
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

/** `--output-format json` 的结果（验证记录 V1）。 */
export interface ClaudeResult {
  sessionId: string | null;
  isError: boolean;
  subtype: string | null;
  resultText: string;
  /** `--json-schema` 的结构化结果。 */
  structured: unknown;
  permissionDenials: string[];
  apiErrorStatus: number | null;
  costUsd: number | null;
}

export type HeadlessFailure = "timeout" | "spawn_failed" | "exit_nonzero" | "bad_output" | "rate_limited" | "claude_error";

export type HeadlessOutcome =
  | { ok: true; result: ClaudeResult }
  | { ok: false; reason: HeadlessFailure; message: string; result: ClaudeResult | null };

export type HeadlessRun = (req: HeadlessRequest) => Promise<HeadlessOutcome>;

/**
 * handoff / 刷新的参数。prompt 不在这里：它走 stdin。
 * `--no-session-persistence`：fork 不写 transcript，“未认领”永远看不到它（验证记录 V2）。
 * `--permission-mode dontAsk`：白名单以外的工具一律拒绝，不受用户默认权限模式影响。
 * `--allowedTools` 放最后：它是可变参数，会吃掉后面的所有值。
 */
export function headlessArgs(o: { schema: string; resumeSessionId?: string; allowedTools: string[] }): string[] {
  const args = ["-p", "--output-format", "json", "--json-schema", o.schema, "--no-session-persistence", "--permission-mode", "dontAsk"];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId, "--fork-session");
  args.push("--disallowedTools", ...DENIED_TOOLS, "--allowedTools", ...o.allowedTools);
  return args;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** 解析 `--output-format json` 的输出：一个 type=result 的对象（防御性地也接受消息数组）。 */
export function parseClaudeJson(stdout: string): ClaudeResult | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const isResult = (m: unknown) => !!m && typeof m === "object" && (m as { type?: unknown }).type === "result";
  const obj = Array.isArray(v) ? [...v].reverse().find(isResult) : v;
  if (!isResult(obj)) return null;
  const o = obj as Record<string, unknown>;
  const denials = Array.isArray(o.permission_denials)
    ? o.permission_denials.map((d) => str((d as { tool_name?: unknown } | null)?.tool_name)).filter((x): x is string => x !== null)
    : [];
  return {
    sessionId: str(o.session_id),
    isError: o.is_error === true,
    subtype: str(o.subtype),
    resultText: str(o.result) ?? "",
    structured: o.structured_output ?? null,
    permissionDenials: denials,
    apiErrorStatus: typeof o.api_error_status === "number" ? o.api_error_status : null,
    costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
  };
}

const RATE_LIMIT_RE = /rate.?limit|usage limit|quota|overloaded|too many requests|\b429\b|\b529\b/i;

/** 额度用完或被限流（启发式：状态码或文本）。只在运行失败时调用。 */
export function isRateLimited(r: ClaudeResult | null, stderr: string): boolean {
  return r?.apiErrorStatus === 429 || r?.apiErrorStatus === 529 || RATE_LIMIT_RE.test(`${r?.resultText ?? ""}\n${stderr}`);
}

/** 结束子进程及其子进程。Windows 上 claude.cmd 经过 cmd.exe，必须杀整棵进程树。 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000).unref();
}

export const runHeadless: HeadlessRun = (req) =>
  new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let child: ChildProcess | undefined;
    const timeoutMs = req.timeoutMs ?? HEADLESS_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child) killTree(child);
    }, timeoutMs);
    const finish = (o: HeadlessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };

    try {
      child = spawn(req.claudePath, req.args, { cwd: req.cwd, env: req.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      finish({ ok: false, reason: "spawn_failed", message: e instanceof Error ? e.message : String(e), result: null });
      return;
    }

    const proc = child;
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (c: string) => {
      if (stdout.length < STDOUT_LIMIT) stdout += c;
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (c: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += c;
    });
    proc.on("error", (e) => finish({ ok: false, reason: "spawn_failed", message: e.message, result: null }));
    proc.on("close", (code) => {
      if (timedOut) {
        finish({ ok: false, reason: "timeout", message: `超过 ${Math.round(timeoutMs / 1000)} 秒没有完成`, result: null });
        return;
      }
      const result = parseClaudeJson(stdout);
      if (!result) {
        const message = (stderr.trim() || stdout.trim()).slice(0, 500) || `exit ${code}`;
        const reason: HeadlessFailure = isRateLimited(null, `${stderr}\n${stdout}`) ? "rate_limited" : code === 0 ? "bad_output" : "exit_nonzero";
        finish({ ok: false, reason, message, result: null });
        return;
      }
      if (result.isError || code !== 0) {
        finish({ ok: false, reason: isRateLimited(result, stderr) ? "rate_limited" : "claude_error", message: (result.resultText || stderr).slice(0, 500), result });
        return;
      }
      finish({ ok: true, result });
    });

    // claude 提前退出时写 stdin 会 EPIPE，忽略即可（结果由 close 事件决定）。
    proc.stdin?.on("error", () => undefined);
    proc.stdin?.end(req.prompt, "utf8");
  });
