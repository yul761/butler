#!/usr/bin/env node
// E2E 用的假 claude（计划 5 任务 8）。只实现 Butler 用到的部分，绝不联网：
//   --version / --help（列出 Butler 检查的全部参数）；
//   交互模式（在 PTY 里）：打印就绪行和挂载的 MCP server 名；每读到一行输入就写 transcript、
//     按 CLAUDE_CONFIG_DIR/settings.json 执行 hook（macOS 用 /bin/sh，Windows 用 Git Bash，和 Claude Code 一样）；
//   -p：从 stdin 读 prompt，按 --json-schema 回预设的 handoff 或刷新结果；stream-json 的 MCP 探测只回 init。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
/** 一个参数出现多次时的所有值（--add-dir）。 */
const flags = (name) => args.flatMap((a, i) => (a === name && i + 1 < args.length ? [args[i + 1]] : []));
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const log = (line) => {
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${new Date().toISOString()} ${line}\n`);
};

const FLAGS = [
  "--print", "--session-id", "--resume", "--fork-session", "--mcp-config", "--output-format", "--json-schema",
  "--allowedTools", "--disallowedTools", "--no-session-persistence", "--permission-mode", "--setting-sources", "--add-dir",
];
const PR = { number: 7, url: "https://example.invalid/pull/7", state: "merged", review: "approved" };
const HANDOFF = {
  ticket: "",
  status: "merged_pending_followup",
  done_today: ["接口写完"],
  next_steps: ["上线后改 staging 配置"],
  blockers: [],
  pr: PR,
  jira: null,
  followups: [{ id: null, kind: "config", description: "改 staging 配置", trigger: "after_merge", due_date: null, done: false }],
  decisions: [{ key: "db", statement: "用 PostgreSQL" }],
  learnings: ["假 claude 的经验"],
  open_questions: [],
};
const REFRESH = { status: "merged_pending_followup", pr: PR, jira: null };

/** 和 Claude Code 一样执行 settings.json 里这个事件的 command hook：stdin 是 JSON，超时 15 秒。 */
function runHooks(event, payload) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return;
  }
  const groups = (settings.hooks && settings.hooks[event]) || [];
  const shell = process.platform === "win32" ? process.env.CLAUDE_CODE_GIT_BASH_PATH || "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/sh";
  for (const group of groups) {
    for (const h of group.hooks || []) {
      if (h.type !== "command") continue;
      const r = spawnSync(shell, ["-c", h.command], { input: JSON.stringify({ ...payload, hook_event_name: event }), env: process.env, timeout: 15_000, windowsHide: true });
      log(`hook ${event} exit=${r.status}${r.error ? ` error=${r.error.message}` : ""}`);
    }
  }
}

function headless() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    log(`headless ${args.filter((a) => !a.startsWith("{")).join(" ")} prompt=${input.length}`);
    if (flag("--output-format") === "stream-json") {
      process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "probe", mcp_servers: [], tools: [] })}\n`);
      return;
    }
    let schema = {};
    try {
      schema = JSON.parse(flag("--json-schema") || "{}");
    } catch {
      // 按 handoff 处理。
    }
    const structured = schema.properties && schema.properties.followups ? HANDOFF : REFRESH;
    const result = { type: "result", subtype: "success", is_error: false, session_id: `fork-${Date.now()}`, result: JSON.stringify(structured), structured_output: structured, permission_denials: [], total_cost_usd: 0 };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
}

function interactive() {
  const sessionId = flag("--session-id") || flag("--resume") || "unknown";
  const cwd = process.cwd();
  const transcript = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  const out = (s) => process.stdout.write(s.replace(/\n/g, "\r\n"));
  const append = (entry) => {
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.appendFileSync(transcript, `${JSON.stringify({ ...entry, sessionId, cwd, timestamp: new Date().toISOString() })}\n`);
  };
  const mcp = flag("--mcp-config");
  let servers = [];
  if (mcp) {
    try {
      servers = Object.keys(JSON.parse(fs.readFileSync(mcp, "utf8")).mcpServers || {});
    } catch (e) {
      servers = [`unreadable ${mcp}: ${e.message}`];
    }
  }
  log(`interactive ${has("--resume") ? "resume" : "new"} ${sessionId} mcp=${servers.join(",")} cwd=${cwd} adddirs=${flags("--add-dir").join("|")}`);
  runHooks("SessionStart", { session_id: sessionId, cwd, source: has("--resume") ? "resume" : "startup", transcript_path: transcript });
  out(`fake claude ready (${sessionId.slice(0, 8)})\n`);
  if (mcp) out(`mcp: ${servers.join(", ")}\n`);
  out("> ");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (raw) => {
    // Butler 用 bracketed paste 写入多行文本（总控开子 session 的任务）：去掉粘贴标记。
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[20[01]~/g, "").trim();
    if (!line) {
      out("> ");
      return;
    }
    if (line === "exit") {
      runHooks("SessionEnd", { session_id: sessionId, cwd, reason: "exit", transcript_path: transcript });
      process.exit(0);
    }
    append({ type: "user", message: { role: "user", content: line } });
    runHooks("UserPromptSubmit", { session_id: sessionId, cwd, prompt: line, transcript_path: transcript });
    const reply = `收到：${line}`;
    append({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
    out(`${reply}\n`);
    runHooks("Stop", { session_id: sessionId, cwd, stop_hook_active: false, transcript_path: transcript });
    out("> ");
  });
  rl.on("close", () => process.exit(0));
}

if (has("--version")) {
  process.stdout.write("2.1.306 (Claude Code)\n");
} else if (has("--help")) {
  process.stdout.write(`Usage: claude [options] [prompt]\n\nOptions:\n${FLAGS.map((f) => `  ${f} <value>  (fake)`).join("\n")}\n`);
} else if (has("-p") || has("--print")) {
  headless();
} else {
  interactive();
}
