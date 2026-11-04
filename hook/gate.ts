import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyGateCommand } from "../src/shared/gate-command";
import { GATE_VERSION, GATE_WAIT_MS, type GateRequest, type GateResult } from "../src/shared/gate";
import { dirFromEnv } from "../src/main/paths";
import { renameWithRetrySync } from "../src/main/util/fs-retry";

export interface GateDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  pidAlive(pid: number): boolean;
  newId(): string;
}

const POLL_MS = 50;

export const realGateDeps: GateDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM：进程在，只是不属于我们。
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  newId: () => randomBytes(16).toString("hex"),
};

function rm(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // 已经不在了。
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 读 hook 的 stdin JSON，返回要写到 stdout 的文字；空串 = 放行。任何异常都放行，永不抛错。 */
export async function runGate(raw: string, env: NodeJS.ProcessEnv, deps: GateDeps): Promise<string> {
  try {
    const p = JSON.parse(raw) as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
    // 命令失败（push 被拒、合并冲突）时 Claude Code 发的是 PostToolUseFailure，不是 PostToolUse：一样当 post，释放占位。
    const ev = p.hook_event_name;
    const phase = ev === "PreToolUse" ? "pre" : ev === "PostToolUse" || ev === "PostToolUseFailure" ? "post" : null;
    const command = p.tool_input?.command;
    if (!phase || p.tool_name !== "Bash" || typeof command !== "string" || typeof p.cwd !== "string") return "";
    // 先本地分类：绝大多数命令不碰文件系统。
    const action = classifyGateCommand(command);
    if (!action) return "";

    const home = homedir();
    const gateDir = join(dirFromEnv(env.BUTLER_HOME, home) ?? join(home, ".butler"), "gate");
    const alive = readJson(join(gateDir, "alive.json")) as { pid?: unknown } | null;
    if (!alive || typeof alive.pid !== "number" || !deps.pidAlive(alive.pid)) return "";

    const request: GateRequest = { v: GATE_VERSION, phase, action, cwd: p.cwd, session: env.BUTLER_SESSION?.trim() || null, ticket: env.BUTLER_TICKET?.trim() || null };
    const id = deps.newId();
    const reqDir = join(gateDir, "requests");
    mkdirSync(reqDir, { recursive: true });
    const reqFile = join(reqDir, `${id}.json`);
    const tmp = `${reqFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(request));
    try {
      renameWithRetrySync(tmp, reqFile);
    } catch (e) {
      rm(tmp);
      throw e;
    }
    if (phase === "post") return "";

    const resFile = join(gateDir, "results", `${id}.json`);
    const deadline = deps.now() + GATE_WAIT_MS;
    for (;;) {
      if (existsSync(resFile)) {
        const res = readJson(resFile) as GateResult | null;
        rm(resFile);
        if (res && res.v === GATE_VERSION && res.decision === "deny" && typeof res.reason === "string") {
          return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: res.reason } });
        }
        return "";
      }
      if (deps.now() >= deadline) break;
      await deps.sleep(POLL_MS);
    }
    rm(reqFile);
    return "";
  } catch {
    return "";
  }
}
