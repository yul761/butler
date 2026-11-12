#!/usr/bin/env node
// E2E 用的假 claude（计划 5 任务 8）。只实现 Butler 用到的部分，绝不联网：
//   --version / --help（列出 Butler 检查的全部参数）；
//   交互模式（在 PTY 里）：打印就绪行和挂载的 MCP server 名；每读到一行输入就写 transcript、
//     按 CLAUDE_CONFIG_DIR/settings.json 和 --settings 文件执行 hook（macOS 用 /bin/sh，Windows 用 Git Bash，和 Claude Code 一样）；
//     输入 /handoff 时按 Claude Code 的格式写命令消息，回一个 handoff 代码块（feature 总控里是 butler-feature-handoff，
//     /handoff <问题> 把它写进 open_questions）；
//     输入 /fake-bash <命令> 时像 Bash 工具在跑：写一条没有结果的 tool_use 和 tasks/<id>.output，这一轮不结束；
//     输入 /fake-bg <命令> 时像后台命令：tool_result 带任务 id 和输出文件，这一轮结束；/fake-bg-done 写它的完成通知；
//     输入 /fake-flood <行数> 时打印这么多行（每行约 100 字节，用来撑满回放缓冲）；
//     输入 /fake-fullscreen 时像 claude 的全屏界面：打开备用屏幕和鼠标上报（只发这一次），之后收到滚轮就记日志；
//     输入 /fake-run <命令> 时像 Bash 工具：先跑 PreToolUse（也读 --settings 里的 hook，合并总控的 gate 在那里），拒绝就打印 denied: <理由>，
//     否则在 cwd 里执行、打印输出、再跑 PostToolUse；日志记 gate deny <理由> / gate allow <命令>，这一轮照常结束；
//     输入 /fake-mcp <工具> <JSON 参数> 时像模型调用工具：按 --mcp-config 启动 butler-sessions，调用它，结果写进运行记录；
//     启动时写一份 sessions/<pid>.json 登记文件，Butler 从这里查 session 的名字；
//     输入 /fake-ask 时回一句以“？”结尾的问话（ASK_REPLY）并结束这一轮：「现在」页的需要你走问号退路认出它；
//     输入 /clear 时像 Claude Code：换一个新的 session id 和新的 transcript，跑 SessionStart（source=clear），停在空的输入框上（没有 Stop）；
//     每条 assistant 记录都带 usage：上下文是 FAKE_CLAUDE_CONTEXT_TOKENS（e2e 用它撑过换新的阈值），/clear 之后从头算，回到 CLEARED_CONTEXT；
//     其余输入回“收到：<输入>”并结束这一轮；每条输入都在运行记录里记一行 prompt <JSON 字符串>；
//   -p：从 stdin 读 prompt，按 --json-schema 回预设的 handoff、刷新结果、feature 汇总或卡住判断；stream-json 的 MCP 探测只回 init。
//     需要你的判断（schema 里有 needs_user）总是失败退出：和真实 e2e 环境里 Haiku 判断失败一样，Butler 走问号退路；
//     FAKE_CLAUDE_JUDGE_DELAY_MS 设了就等这么久才失败（像真的 Haiku 要判断几秒）。
//     FAKE_CLAUDE_SUMMARY_GATE 指向的文件存在时，feature 汇总等到文件被删掉才回答：e2e 用它控制归档前要等多久。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

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
  "--settings",
];
const PR = { number: 7, url: "https://github.com/acme/backend/pull/7", state: "merged", review: "approved" };
const HANDOFF = {
  ticket: "",
  status: "merged_pending_followup",
  done_today: ["接口写完"],
  next_steps: ["上线后改 staging 配置"],
  blockers: [],
  prs: [PR],
  jira: null,
  followups: [{ id: null, kind: "config", description: "改 staging 配置", trigger: "after_merge", due_date: null, done: false }],
  decisions: [{ key: "db", statement: "用 PostgreSQL" }],
  learnings: ["假 claude 的经验"],
  open_questions: [],
};
const REFRESH = { status: "merged_pending_followup", prs: [PR], jira: null };
/** ticket session 里键入 /handoff 时输出的 butler-handoff：PR 还开着、已 approve（不会触发 worktree 清理）。 */
const COMMAND_HANDOFF = {
  ...HANDOFF,
  status: "in_review",
  done_today: ["结账页写完"],
  next_steps: ["等 review"],
  prs: [{ number: 12, url: "https://github.com/acme/frontend/pull/12", state: "open", review: "approved" }],
  followups: [],
  decisions: [],
  learnings: [],
};
/** feature 总控里键入 /handoff 时输出的 butler-feature-handoff。ticket 号故意写成小写，入库时规范成大写。 */
const COMMAND_FEATURE_HANDOFF = {
  summary: "结账页前端（DMS-1）已提 PR 等合并；后端下单接口（DMS-2）还在写，两边还没联调。",
  blockers: ["DMS-2 等支付网关的测试账号"],
  next_steps: [{ ticket: "dms-2", text: "写完下单接口" }, { ticket: null, text: "两边合并后联调结账流程" }],
  decisions: [{ key: "order-api", statement: "下单接口返回 order_id" }],
  open_questions: [],
};
/** 手动"立即更新"（headless，--json-schema 是 feature 汇总）的结果，跟着 prompt 的语言走。 */
const FEATURE_SUMMARY = {
  zh: {
    summary: "后端下单接口（DMS-2）已合并；前端结账页（DMS-1）的 PR 已 approve，合并后就能联调。",
    blockers: ["DMS-1 等支付表单的设计 review"],
    next_steps: [{ ticket: "DMS-1", text: "合并结账页的 PR" }, { ticket: null, text: "在 staging 联调结账流程" }],
    decisions: [{ key: "order-api", statement: "下单接口返回 order_id" }],
    open_questions: [],
  },
  en: {
    summary: "The backend order API (DMS-2) is merged; the frontend checkout page (DMS-1) has an approved PR, and the two can be wired up once it is merged.",
    blockers: ["DMS-1 is waiting for the design review of the payment form"],
    next_steps: [{ ticket: "DMS-1", text: "Merge the checkout page PR" }, { ticket: null, text: "Test the checkout flow end to end on staging" }],
    decisions: [{ key: "order-api", statement: "The order API returns order_id" }],
    open_questions: [],
  },
};

/** 卡住判断（headless）总是说卡住了，跟着 prompt 的语言走。 */
const STUCK_VERDICT = {
  zh: { stuck: true, reason: "测试进程在等一个不会来的信号", action: "确认测试进程没有在动，再决定要不要杀掉重跑" },
  en: { stuck: true, reason: "The test process is waiting for a signal that will not come", action: "Check that the test process is idle, then decide whether to kill and rerun it" },
};
/** /fake-ask 的回复：停下来问用户。 */
const ASK_REPLY = "要把它拆成两个 PR 吗？";
/** /fake-bash 和 /fake-bg 写进输出文件的内容：比面板的 6 行多。 */
const COMMAND_OUTPUT = Array.from({ length: 8 }, (_, i) => `step ${i + 1} of 8`);

/** 没设 FAKE_CLAUDE_CONTEXT_TOKENS 时、以及 /clear 之后回复的上下文：比 e2e 里设的换新阈值小。 */
const CLEARED_CONTEXT = 500;

/** hook 和 /fake-run 的命令都用这个 shell 跑（macOS 用 /bin/sh，Windows 用 Git Bash，和 Claude Code 一样）。 */
const SHELL = process.platform === "win32" ? process.env.CLAUDE_CODE_GIT_BASH_PATH || "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/sh";

/** 一个 settings 文件里这个事件的 hook 组；读不了就没有。 */
function hookGroups(file, event) {
  try {
    const settings = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return (settings.hooks && settings.hooks[event]) || [];
  } catch {
    return [];
  }
}

/**
 * 和 Claude Code 一样执行这个事件的 command hook：CLAUDE_CONFIG_DIR/settings.json 里的，加上 --settings 文件里的（合并总控的 gate hook 只在那里）。
 * stdin 是 JSON，超时 15 秒。返回每个 hook 的 stdout。
 */
function runHooks(event, payload) {
  const files = [path.join(configDir, "settings.json"), ...(flag("--settings") ? [flag("--settings")] : [])];
  const outputs = [];
  for (const group of files.flatMap((f) => hookGroups(f, event))) {
    if (group.matcher && payload.tool_name && !new RegExp(`^(${group.matcher})$`).test(payload.tool_name)) continue;
    for (const h of group.hooks || []) {
      if (h.type !== "command") continue;
      const r = spawnSync(SHELL, ["-c", h.command], { input: JSON.stringify({ ...payload, hook_event_name: event }), env: process.env, encoding: "utf8", timeout: 15_000, windowsHide: true });
      log(`hook ${event} exit=${r.status}${r.error ? ` error=${r.error.message}` : ""}`);
      outputs.push(r.stdout || "");
    }
  }
  return outputs;
}

/** PreToolUse hook 的输出里有拒绝就返回理由（Claude Code 的 hookSpecificOutput.permissionDecision），否则 null。 */
function denyReason(outputs) {
  for (const o of outputs) {
    try {
      const h = JSON.parse(o).hookSpecificOutput;
      if (h && h.permissionDecision === "deny") return String(h.permissionDecisionReason || "");
    } catch {
      // 不是 JSON：不算拒绝。
    }
  }
  return null;
}

function headless() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    log(`headless ${args.filter((a) => !a.startsWith("{")).join(" ")} prompt=${input.length} cwd=${process.cwd()}`);
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
    const props = schema.properties || {};
    if (props.needs_user) {
      // 不假装 Haiku：判断失败，Butler 按回复是不是以问号结尾来定。FAKE_CLAUDE_JUDGE_DELAY_MS 让它像真的 Haiku 一样过一会儿才失败。
      setTimeout(() => {
        log("needs-you judge failed");
        process.stderr.write("fake claude does not judge needs-you\n");
        process.exitCode = 1;
      }, Number(process.env.FAKE_CLAUDE_JUDGE_DELAY_MS) || 0);
      return;
    }
    // prompt 的第一行有中文就当中文，否则英文（Butler 按界面语言出 prompt）。
    const lang = /[\u4e00-\u9fff]/.test(input.split("\n")[0]) ? "zh" : "en";
    const judge = !!props.stuck;
    // 整个 prompt 记下来：e2e 用它确认 Butler 真的读到了输出和子进程 CPU。
    if (judge) log(`judge prompt ${JSON.stringify(input)}`);
    const summary = !judge && !props.followups && !!props.open_questions && !!props.summary;
    const structured = judge ? STUCK_VERDICT[lang] : props.followups ? HANDOFF : summary ? FEATURE_SUMMARY[lang] : REFRESH;
    const result = { type: "result", subtype: "success", is_error: false, session_id: `${judge ? "judge" : "fork"}-${Date.now()}`, result: JSON.stringify(structured), structured_output: structured, permission_denials: [], total_cost_usd: 0 };
    const gate = summary ? process.env.FAKE_CLAUDE_SUMMARY_GATE : undefined;
    const held = () => gate !== undefined && fs.existsSync(gate);
    const answer = () => (held() ? setTimeout(answer, 50) : process.stdout.write(`${JSON.stringify(result)}\n`));
    if (held()) log("summary held");
    answer();
  });
}

/** 和 Claude Code 一样：按配置启动 stdio 的 MCP server，握手后调用一个工具。env 在继承的环境上叠加配置里的，BUTLER_SESSION 就是这样传下去的。 */
function callMcpTool(configPath, tool, input) {
  return new Promise((resolve, reject) => {
    const server = JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers["butler-sessions"];
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    child.on("error", reject);
    readline.createInterface({ input: child.stdout }).on("line", (reply) => {
      const m = JSON.parse(reply);
      if (m.id === 1) send(2, "tools/call", { name: tool, arguments: input });
      if (m.id !== 2) return;
      child.kill();
      resolve(m.result);
    });
    send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  });
}

function interactive() {
  // /clear 会换掉 session id，transcript 和命令输出目录跟着换。
  let sessionId = flag("--session-id") || flag("--resume") || "unknown";
  const cwd = process.cwd();
  const project = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const transcriptOf = (id) => path.join(configDir, "projects", project, `${id}.jsonl`);
  let transcript = transcriptOf(sessionId);
  // Claude Code 放命令输出的地方：真实的系统临时目录，不跟 TMPDIR 走（Windows 上位置还没验证，用 TMPDIR）。
  const claudeTmp = process.platform === "win32" ? os.tmpdir() : path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", `claude-${process.getuid()}`);
  const tasksDirOf = (id) => path.join(claudeTmp, project, id, "tasks");
  let tasksDir = tasksDirOf(sessionId);
  /** 这一段对话的上下文大小，写进每条 assistant 记录的 usage（Butler 的 UsageScanner 读它）。 */
  let contextTokens = Number(process.env.FAKE_CLAUDE_CONTEXT_TOKENS) || CLEARED_CONTEXT;
  const usage = () => ({ input_tokens: contextTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 });
  const out = (s) => process.stdout.write(s.replace(/\n/g, "\r\n"));
  const append = (entry) => {
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.appendFileSync(transcript, `${JSON.stringify({ ...entry, sessionId, cwd, timestamp: new Date().toISOString() })}\n`);
  };
  const mcp = flag("--mcp-config");
  let servers = [];
  // butler-sessions 是 feature 模式（BUTLER_FEATURE）的才是 feature 总控：普通 ticket session 也挂 butler-sessions（只有 ask_user、report）。
  let featureCoordinator = false;
  if (mcp) {
    try {
      const all = JSON.parse(fs.readFileSync(mcp, "utf8")).mcpServers || {};
      servers = Object.keys(all);
      featureCoordinator = Boolean(all["butler-sessions"]?.env?.BUTLER_FEATURE);
    } catch (e) {
      servers = [`unreadable ${mcp}: ${e.message}`];
    }
  }
  // 和 Claude Code 一样登记运行中的 session（/clear 之后改成新的 id，名字不变）。
  const name = `fake-${sessionId.slice(0, 8)}`;
  const register = () => {
    fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, cwd, name, status: "idle" }));
  };
  register();
  log(`interactive ${has("--resume") ? "resume" : "new"} ${sessionId} mcp=${servers.join(",")} cwd=${cwd} adddirs=${flags("--add-dir").join("|")}`);
  runHooks("SessionStart", { session_id: sessionId, cwd, source: has("--resume") ? "resume" : "startup", transcript_path: transcript });
  out(`fake claude ready (${sessionId.slice(0, 8)})\n`);
  if (mcp) out(`mcp: ${servers.join(", ")}\n`);
  out("> ");
  /** assistant 记录的 message.id：和 Claude Code 一样每条回复一个（「需要你」按它每条只判断一次）。 */
  let messages = 0;
  const messageId = () => `msg-${process.pid}-${++messages}`;
  /** 写一条 Bash 的 tool_use 和它的输出文件。 */
  const startBash = (command, input) => {
    const toolId = `toolu-${Date.now()}`;
    const taskId = `task-${Date.now()}`;
    const output = path.join(tasksDir, `${taskId}.output`);
    fs.mkdirSync(tasksDir, { recursive: true });
    append({ type: "assistant", uuid: `a-${Date.now()}`, message: { id: messageId(), role: "assistant", stop_reason: "tool_use", usage: usage(), content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command, ...input } }] } });
    fs.writeFileSync(output, `${COMMAND_OUTPUT.join("\n")}\n`);
    log(`task output ${output}`);
    return { toolId, taskId, output };
  };
  /** 正在跑的后台命令的任务 id。 */
  let backgroundTask = null;
  const rl = readline.createInterface({ input: process.stdin });
  // bracketed paste（总控交任务时 Butler 这样写入）：粘贴里的几行合成一条消息。PTY 按行交付，粘贴结束标记所在的那一行
  // 只有等到 Butler 随后的回车才会到，所以读到结束标记就提交。
  let pasting = null;
  let pasted = null;
  rl.on("line", (raw) => {
    if (raw.includes("\x1b[200~") || pasting) {
      const text = raw.replace("\x1b[200~", "");
      const end = text.indexOf("\x1b[201~");
      pasting = [...(pasting || []), end >= 0 ? text.slice(0, end) : text];
      if (end < 0) return;
      pasted = pasting.join("\n");
      pasting = null;
    }
    const line = pasted !== null ? pasted.trim() : raw.trim();
    pasted = null;
    if (!line) {
      out("> ");
      return;
    }
    // 每条收到的输入都记一笔（JSON 字符串）：e2e 按顺序核对 Butler 往终端里输入了什么，屏幕上的早已滚走。
    log(`prompt ${JSON.stringify(line)}`);
    if (line === "exit") {
      runHooks("SessionEnd", { session_id: sessionId, cwd, reason: "exit", transcript_path: transcript });
      process.exit(0);
    }
    const flood = /^\/fake-flood (\d+)$/.exec(line);
    if (flood) {
      // 一屏放不下的输出：e2e 用它检查终端能不能往回滚。
      for (let i = 1; i <= Number(flood[1]); i++) out(`flood line ${i} ${"-".repeat(80)}\n`);
      out("> ");
      return;
    }
    if (line === "/fake-fullscreen") {
      out("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h");
      // SGR 鼠标上报里的滚轮：按钮 64 往上、65 往下。
      process.stdin.on("data", (d) => {
        // eslint-disable-next-line no-control-regex
        const wheel = /\x1b\[<(64|65);\d+;\d+M/.exec(d.toString());
        if (wheel) log(`mouse wheel ${wheel[1] === "64" ? "up" : "down"}`);
      });
      out("> ");
      return;
    }
    if (line === "/clear") {
      // Claude Code 的 /clear：新的 session id 和 transcript，SessionStart 的 source 是 clear；BUTLER_SESSION 不变，Butler 按它把新 id 接到这个终端上。
      // 不算一次提问（没有 UserPromptSubmit），之后停在空的输入框上，也没有 Stop。上下文从头算。
      sessionId = randomUUID();
      transcript = transcriptOf(sessionId);
      tasksDir = tasksDirOf(sessionId);
      contextTokens = CLEARED_CONTEXT;
      register();
      log(`clear ${sessionId}`);
      runHooks("SessionStart", { session_id: sessionId, cwd, source: "clear", transcript_path: transcript });
      out(`fake claude cleared (${sessionId.slice(0, 8)})\n> `);
      return;
    }
    if (line === "/fake-bg-done") {
      // 后台命令结束：Claude Code 写的是这条通知，不是用户消息。
      append({ type: "queue-operation", operation: "enqueue", content: `<task-notification><task-id>${backgroundTask}</task-id><status>completed</status></task-notification>` });
      out("> ");
      return;
    }
    const bash = /^\/fake-(bash|bg) (.+)$/.exec(line);
    const tool = /^\/fake-mcp (\S+)(?: (.+))?$/.exec(line);
    const command = /^\/handoff(\s|$)/.test(line);
    if (command) {
      // Claude Code 的斜杠命令：一条命令消息，再跟一条 isMeta 的命令文件展开。
      append({ type: "user", message: { role: "user", content: "<command-message>handoff</command-message>\n<command-name>/handoff</command-name>" } });
      let body = "";
      try {
        body = fs.readFileSync(path.join(configDir, "commands", "handoff.md"), "utf8");
      } catch {
        // 没装命令文件也照样回代码块。
      }
      append({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: body }] } });
    } else {
      append({ type: "user", message: { role: "user", content: line } });
    }
    runHooks("UserPromptSubmit", { session_id: sessionId, cwd, prompt: line, transcript_path: transcript });
    if (bash && bash[1] === "bash") {
      // 前台命令在跑：没有结果，这一轮不结束，也不打印新的提示符。
      startBash(bash[2], {});
      out("running\n");
      return;
    }
    if (bash) {
      const { toolId, taskId, output } = startBash(bash[2], { run_in_background: true });
      backgroundTask = taskId;
      append({ type: "user", toolUseResult: { backgroundTaskId: taskId }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `Command running in background with ID: ${taskId}. Output is being written to: ${output}. You will be notified when it completes \u2014 do not poll that file or sleep while waiting.` }] } });
    }
    const endTurn = (reply) => {
      append({ type: "assistant", uuid: `a-${Date.now()}`, message: { id: messageId(), role: "assistant", stop_reason: "end_turn", usage: usage(), content: [{ type: "text", text: reply }] } });
      out(`${reply}\n`);
      runHooks("Stop", { session_id: sessionId, cwd, stop_hook_active: false, transcript_path: transcript });
      out("> ");
    };
    const run = /^\/fake-run (.+)$/.exec(line);
    if (run) {
      // 像 Bash 工具：PreToolUse 拒绝就不执行；否则在 cwd 里执行，再跑 PostToolUse。e2e 按日志里的 gate deny / gate allow 判断。
      const toolInput = { command: run[1] };
      const base = { session_id: sessionId, cwd, tool_name: "Bash", tool_input: toolInput, transcript_path: transcript };
      log(`fake-run ${run[1]}`);
      const reason = denyReason(runHooks("PreToolUse", base));
      if (reason !== null) {
        log(`gate deny ${reason}`);
        out(`denied: ${reason}\n`);
        endTurn("命令被拒绝");
        return;
      }
      const r = spawnSync(SHELL, ["-c", run[1]], { cwd, env: process.env, encoding: "utf8", timeout: 15_000, windowsHide: true });
      out(`${r.stdout || ""}${r.stderr || ""}`);
      runHooks("PostToolUse", { ...base, tool_response: { stdout: r.stdout || "", stderr: r.stderr || "", interrupted: false } });
      log(`gate allow ${run[1]}`);
      endTurn(`命令结束（exit ${r.status}）`);
      return;
    }
    if (tool) {
      // 工具在等 Butler 回话，这一轮结束不了；结果记下来给 e2e 读，终端里的文字会被折行。
      callMcpTool(mcp, tool[1], tool[2] ? JSON.parse(tool[2]) : {}).then(
        (result) => {
          log(`mcp result ${JSON.stringify(result)}`);
          endTurn(`工具返回：${tool[1]}`);
        },
        (e) => endTurn(`工具失败：${e.message}`),
      );
      return;
    }
    const coordinator = featureCoordinator;
    const question = /^\/handoff\s+(.+)$/.exec(line);
    const featureHandoff = { ...COMMAND_FEATURE_HANDOFF, open_questions: question ? [question[1]] : [] };
    endTurn(line === "/fake-ask"
      ? ASK_REPLY
      : !command
        ? `收到：${line}`
        : coordinator
          ? `handoff：\n\n\`\`\`butler-feature-handoff\n${JSON.stringify(featureHandoff, null, 2)}\n\`\`\``
          : `handoff：\n\n\`\`\`butler-handoff\n${JSON.stringify(COMMAND_HANDOFF, null, 2)}\n\`\`\``);
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
