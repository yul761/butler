#!/usr/bin/env node
// UI 重做第 5 层 Task 1 的缓存实测（开发时手动跑，不进 app，只在 macOS / Linux 上用）。
// 用法：node scripts/fork-cache-spike.mjs <开发 session id> --variant v1|v2|v2-no-perm|v2-dev-mcp [--dry-run]
// 找到这个开发 session 正在跑的 claude 进程，照抄它的参数做一次 `claude -p --resume <id> --fork-session`，
// 只问一句不用工具的话，看第一轮的 cache_read 是不是接近开发 session 的整段上下文。
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const VARIANTS = ["v1", "v2", "v2-no-perm", "v2-dev-mcp"];
const ALLOWED = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status)", "Bash(git show:*)"];
const PROMPT = "只回答 OK 两个字母，不要调用任何工具。";

const argv = process.argv.slice(2);
const devId = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--variant");
const variant = argv[argv.indexOf("--variant") + 1];
const dryRun = argv.includes("--dry-run");
if (!devId || !VARIANTS.includes(variant)) {
  console.error(`用法：node scripts/fork-cache-spike.mjs <开发 session id> --variant ${VARIANTS.join("|")} [--dry-run]`);
  process.exit(2);
}

// 1. 开发 session 的进程：带这个 id、不带 -p 的 claude。
const ps = execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" });
const line = ps.split("\n").map((l) => l.trim()).find((l) => l.includes(devId) && /\bclaude\b/.test(l) && !/\s-p(\s|$)/.test(l) && !l.includes("fork-cache-spike"));
if (!line) {
  console.error("找不到这个开发 session 的 claude 进程——这个 session 得开着。");
  process.exit(1);
}
const pid = Number(line.split(/\s+/)[0]);
const parts = line.split(/\s+/).slice(1);
const bin = parts[0];
const devArgs = parts.slice(1);
// ps 不保留引号；参数里有空格时拆不准，打出来让人确认。
console.log(`开发进程 ${pid}：${bin}\n  参数：${JSON.stringify(devArgs)}`);

// 2. 工作目录和环境变量。
const cwd = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("n"))?.slice(1);
if (!cwd) {
  console.error("拿不到开发进程的工作目录");
  process.exit(1);
}
const devEnv = {};
try {
  // macOS 的 `ps eww` 会把环境变量接在参数后面；只取 CLAUDE_ 开头的（比如 CLAUDE_EFFORT），它们会改请求。
  const envLine = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  for (const tok of envLine.split(/\s+/)) {
    const m = /^(CLAUDE_[A-Z0-9_]+)=(.*)$/.exec(tok);
    if (m && !m[1].includes("TOKEN") && !m[1].includes("KEY")) devEnv[m[1]] = m[2];
  }
} catch {
  /* 拿不到就算了 */
}
console.log(`  工作目录：${cwd}\n  CLAUDE_* 环境：${JSON.stringify(devEnv)}`);

// 3. 开发 session 的上下文大小和最后一轮时间（照 usage-repo.latestContext）。
let devContext = null;
let lastAt = null;
try {
  const db = new DatabaseSync(join(homedir(), ".butler", "app.db"), { readOnly: true });
  const r = db.prepare(`SELECT context, at FROM session_usage WHERE session_id = ? AND source = 'session' ORDER BY at DESC LIMIT 1`).get(devId);
  if (r) {
    devContext = Number(r.context);
    lastAt = Number(r.at);
  }
  db.close();
} catch (e) {
  console.warn(`读不到 ~/.butler/app.db：${e.message}`);
}
if (devContext === null) {
  // 不是 Butler 开的 session（比如手动开的对照组）：从 transcript 最后一条 assistant 的 usage 取。
  try {
    const dir = execFileSync("find", [join(homedir(), ".claude", "projects"), "-name", `${devId}.jsonl`], { encoding: "utf8" }).trim().split("\n")[0];
    for (const l of readFileSync(dir, "utf8").trim().split("\n").reverse()) {
      const e = JSON.parse(l);
      const u = e.type === "assistant" ? e.message?.usage : null;
      if (!u) continue;
      devContext = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      lastAt = Date.parse(e.timestamp);
      break;
    }
  } catch (e) {
    console.warn(`从 transcript 也拿不到上下文：${e.message}`);
  }
}
const ago = lastAt === null ? null : (Date.now() - lastAt) / 60_000;
console.log(`  开发上下文：${devContext ?? "未知"}；最后一轮在 ${ago === null ? "未知" : `${ago.toFixed(1)} 分钟前`}`);

// 4. 拼参数。
const flagValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const replaceValue = (args, flag, value) => {
  const i = args.indexOf(flag);
  if (i >= 0) args[i + 1] = value;
};
let args = [...devArgs];
const sid = args.indexOf("--session-id");
if (sid >= 0) args[sid] = "--resume";
if (flagValue(args, "--resume") !== devId) {
  console.error("开发参数里既没有 --session-id 也没有 --resume 这个 id");
  process.exit(1);
}
args.push("-p", "--output-format", "json", "--fork-session");

if (variant !== "v1") {
  const settingsPath = flagValue(args, "--settings");
  if (settingsPath) {
    const dev = JSON.parse(readFileSync(settingsPath, "utf8"));
    const copy = { ...dev, permissions: { ...(dev.permissions ?? {}), allow: [] }, hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "true", timeout: 10 }] }] } };
    const p = join(tmpdir(), `fork-spike-settings-${createHash("sha1").update(JSON.stringify(copy)).digest("hex").slice(0, 12)}.json`);
    writeFileSync(p, JSON.stringify(copy, null, 2));
    replaceValue(args, "--settings", p);
  }
  if (variant !== "v2-dev-mcp") {
    const mcpPath = flagValue(args, "--mcp-config");
    if (mcpPath) {
      // 换掉开发 session 的身份（termId / session id），server 集合不变。
      const text = readFileSync(mcpPath, "utf8").split(devId).join("fork-spike");
      const p = join(tmpdir(), `fork-spike-mcp-${createHash("sha1").update(text).digest("hex").slice(0, 12)}.json`);
      writeFileSync(p, text);
      replaceValue(args, "--mcp-config", p);
    }
  }
  if (variant !== "v2-no-perm") args.push("--permission-mode", "dontAsk", "--allowedTools", ...ALLOWED);
}

const env = { ...process.env, ...devEnv, BUTLER_SESSION: "headless:spike" };
env.CLAUDE_CODE_SUBAGENT_MODEL ??= "sonnet";
env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ??= "250000";

console.log(`\n变体 ${variant}：${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
for (const bad of ["--disallowedTools", "--json-schema", "--setting-sources", "--no-session-persistence"]) {
  if (args.includes(bad)) console.warn(`警告：参数里有 ${bad}`);
}
if (dryRun) process.exit(0);

// 5. 跑一次（提示词经 stdin），读 usage。
const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stdin.end(PROMPT);
const code = await new Promise((r) => child.on("close", r));
let res;
try {
  res = JSON.parse(out);
} catch {
  console.error(`输出不是 JSON（退出码 ${code}）：\n${out.slice(0, 2000)}`);
  process.exit(1);
}
const u = res.usage ?? {};
const input = u.input_tokens ?? 0;
const w = u.cache_creation ?? {};
const write5m = w.ephemeral_5m_input_tokens ?? 0;
const write1h = w.ephemeral_1h_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - write5m;
const read = u.cache_read_input_tokens ?? 0;
const total = input + write5m + write1h + read;
const r1 = total > 0 ? read / total : 0;
const r2 = devContext ? read / devContext : null;
const pass = r1 >= 0.9 && r2 !== null && r2 >= 0.8;
console.log(JSON.stringify({ variant, input, cacheWrite5m: write5m, cacheWrite1h: write1h, cacheRead: read, output: u.output_tokens ?? 0, total_cost_usd: res.total_cost_usd, session_id: res.session_id, result: res.result, r1: Number(r1.toFixed(3)), r2: r2 === null ? null : Number(r2.toFixed(3)), devLastTurnMinutesAgo: ago === null ? null : Number(ago.toFixed(1)), verdict: pass ? "PASS" : "FAIL" }, null, 2));
console.log(`\n分叉的 transcript 在 ~/.claude/projects/ 下（${res.session_id}.jsonl），用完可以手动删。`);
