#!/usr/bin/env node
// E2E 用的假 claude（计划 5 任务 8）。只实现 Shipherd 用到的部分，绝不联网：
//   --version / --help（列出 Shipherd 检查的全部参数）；
//   交互模式（在 PTY 里）：打印就绪行和挂载的 MCP server 名；每读到一行输入就写 transcript、
//     按 CLAUDE_CONFIG_DIR/settings.json 和 --settings 文件执行 hook（macOS 用 /bin/sh，Windows 用 Git Bash，和 Claude Code 一样）；
//     输入 /handoff 时按 Claude Code 的格式写命令消息，回一个 handoff 代码块（feature 总控里是 shipherd-feature-handoff，
//     /handoff <问题> 把它写进 open_questions；FAKE_HANDOFF_PRS（JSON 数组）设了就用它换掉 ticket handoff 默认报的 PR）；
//     输入 /fake-bash <命令> 时像 Bash 工具在跑：写一条没有结果的 tool_use 和 tasks/<id>.output，这一轮不结束；
//     输入 /fake-bg <命令> 时像后台命令：tool_result 带任务 id 和输出文件，这一轮结束；/fake-bg-done 写它的完成通知；
//       和 Claude Code 一样，命令在跑的时候有一个后台 shell 子进程（不真的执行命令，等到完成通知或假 claude 退出）：
//       Shipherd 进程树里找不到它的 shell 就当后台任务已经结束（BTL-190 第 1 点）；
//     输入 /fake-links 时打印三行链接（BTL-257）：一个 https 的 OSC 8 超链接、一个普通文本里的 https URL、一个 file: 的 OSC 8 超链接；
//     输入 /fake-flood <行数> 时打印这么多行（每行约 100 字节，用来撑满回放缓冲）；
//     输入 /fake-fullscreen 时像 claude 的全屏界面：打开备用屏幕和鼠标上报（只发这一次），之后收到滚轮就记日志；
//     输入 /fake-run <命令> 时像 Bash 工具：先跑 PreToolUse（也读 --settings 里的 hook，合并总控的 gate 在那里），拒绝就打印 denied: <理由>，
//     否则在 cwd 里执行、打印输出、再跑 PostToolUse；日志记 gate deny <理由> / gate allow <命令>，这一轮照常结束；
//     输入 /fake-edit <相对路径> <JSON 字符串> 时像 Write 工具：把内容写进 cwd 下的文件，跑 PostToolUse（tool_name=Write，也读 --settings 里的 hook），
//       hook 回了 block 就记 check block <理由>，只给了提示就记 check note <提示>（换行记成 ⏎），这一轮照常结束；
//     输入 /fake-skill <skill 名> 时像 Skill 工具：跑 PostToolUse（tool_name=Skill，带 tool_use_id；也读 --settings 里 matcher 为 Skill 的 hook），打印 skill <名>，这一轮照常结束；
//     输入 /fake-tool <工具名> [JSON 参数] 时写一条 tool_use 和它的结果，这一轮不结束（实况窗口：工具调用、记忆读写的行和光点）；
//       之后跑 PostToolUse（tool_name=工具名，也读 --settings 里的 hook）：hook 输出的 additionalContext 记成 additional-context <一行>（信箱，BTL-245）；
//     输入 /fake-work <秒> <毫秒> [spinner 毫秒] 时像一个在干活的 session（BTL-242 的性能场景）：这么多秒里每隔这么多毫秒写一条 tool_use 和结果、
//       打印约 2KB 的终端输出，到点后结束这一轮；给了第三个数就再每隔这么多毫秒重画一行 spinner（BTL-277）；
//     输入 /fake-nostop [always] <回复> 时写完回复、画一个空输入框（两条线夹着「> 」，下面六行状态栏），但不跑 Stop hook（BTL-279：Claude Code 丢了 Stop）；
//       带 always 的话之后每一轮都这样结束；
//     输入 /fake-later <毫秒> <一行> 时过这么久再把那一行当成输入（e2e 在别的页面上等它带来的变化）；
//     输入 /fake-mcp <工具> <JSON 参数> 时像模型调用工具：按 --mcp-config 启动 shipherd-sessions，调用它，结果写进运行记录；
//     启动时写一份 sessions/<pid>.json 登记文件，Shipherd 从这里查 session 的名字；
//     输入 /fake-ask 时回一句以“？”结尾的问话（ASK_REPLY）并结束这一轮：需要你的判断认出它；
//     输入 /fake-limit <文字> 时像 Claude Code 撞了额度：写一条它合成的 assistant 报错（isApiErrorMessage、model <synthetic>），
//       再写 system / turn_duration 结束这一轮，不跑 Stop（真的 CLI 这时触发的是 StopFailure）；
//     输入 /clear 时像 Claude Code：换一个新的 session id 和新的 transcript，跑 SessionStart（source=clear），停在空的输入框上（没有 Stop）；
//     每条 assistant 记录都带 usage：上下文是 FAKE_CLAUDE_CONTEXT_TOKENS（e2e 用它撑过换新的阈值），/clear 之后从头算，回到 CLEARED_CONTEXT；
//     交互日志另有 interactive-allow <id> <JSON>：--settings 文件里 permissions.allow 的内容；
//     交互日志 interactive new/resume 行末尾带 guide=<--append-system-prompt-file 的路径>（没有就是空）；
//     FAKE_CLAUDE_SCRIPT 指向一个剧本（JSON，只给演示录制用，BTL-251）时：banner 换掉就绪行和 mcp 行；收到的输入里含某条规则的 when，
//       就回它的 reply（没有 reply 就不回、这一轮不结束），再按 then 里每一步的 after（毫秒，从收到起算）把 line 当成输入；
//       这些输入不写进 transcript 的用户消息、不跑 UserPromptSubmit，这一步结束这一轮时回的话换成它的 say；
//     输入 /fake-recall 时把 transcript 里用户说过的话列出来（日志 fake-recall <JSON>）：--resume 以后看得出原来的对话还在；
//     其余输入回“收到：<输入>”并结束这一轮；每条输入都在运行记录里记一行 prompt <JSON 字符串>；
//   -p：从 stdin 读 prompt，按 --json-schema 回预设的 handoff、刷新结果、feature 汇总或卡住判断；stream-json 的 MCP 探测只回 init。
//     需要你的判断（schema 里有 needs_user）：回复是 /fake-ask 的问话就说需要你（理由是那句问话），别的都失败退出（Shipherd 当作不需要你）；
//     FAKE_CLAUDE_JUDGE_DELAY_MS 设了就等这么久才失败（像真的 Haiku 要判断几秒）。
//     规矩补填（schema 里有 enriched）：每条规矩补上 globs ["src/**"]，正文提到 console 的算 checkable；运行记录记一行 lesson enrich <条数>；
//     合并相似规矩（schema 里有 merges）：给的几条（两条以上）合成一条「合并：<第一条>」；运行记录记一行 lesson merge <条数>；
//     规矩准入（schema 里有 groups / conflicts / clarity / classified / reviews / principles）：没有重复和冲突、都清楚、
//       提到 console 的算 checkable、抽查都通过、不归原则；运行记录记一行 admission <键> <条数>；
//     review 经验的分析（schema 里有 findings）：每次重新读 FAKE_CLAUDE_LESSONS_FILE 里的模式，运行记录记一行 lessons <模式>：
//       没有这个文件或 ok → 回 { findings: [] }，带花费、时长和 modelUsage；
//       fail → stdout 一个 is_error 的结果（result 是 boom，带花费），stderr 一行 fake lessons stderr: boom，退出 1；
//       limit:<秒级时间戳> → stdout 一个 is_error 的结果“Claude AI usage limit reached|<时间戳>”（CLI 撞额度的格式），退出 1；
//     预审（schema 里有 violations）：没有违规；证据核对（items）：每条 consistent；简报摘要（只有 summary）：一句固定的话；
//     仓库现状的模型补全（schema 里有 inferred_checks）：回一条测试命令和一条 lint 命令，记一行 repo scan infer；FAKE_CLAUDE_INFER=fail 时失败退出；
//     FAKE_CLAUDE_SUMMARY_GATE 指向的文件存在时，feature 汇总等到文件被删掉才回答：e2e 用它控制归档前要等多久。
//   -p 不带 --json-schema：分叉讨论（UI 重做第 5 层）。运行记录写 fork-run <参数 JSON> 和 fork-session <回的 id>；
//     回「分叉回答：<prompt 的最后一行>」，最后一行提到「结论」（conclusionAsk）时回「结论：把 X 改成 Y」；
//     --fork-session 或者没有 --resume 时 session_id 是新的，只有 --resume X 时就是 X；usage 读了缓存，每一轮花 0.02；
//     total_cost_usd 和真的 CLI 一样是累计的：续 X 时是 X 的累计加 0.02，--fork-session 还带着被分叉 session 以前的花费（开发 session 当它花过 1.00）；
//     modelUsage 也是累计的，和 total 对得上（每 0.02 一轮 FORK_USAGE 的 token），按份额拆出来每一轮正好 0.02；
//     FAKE_CLAUDE_FORK=limit[:<秒级时间戳>] 时照复盘分析 limit: 的写法回撞额度（没给时间就是一小时后），退出 1。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const http = require("node:http");
const { URL } = require("node:url");

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
  "--settings", "--model", "--effort",
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
/** ticket session 里键入 /handoff 时输出的 shipherd-handoff：PR 还开着、已 approve（不会触发 worktree 清理）。 */
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
/** ticket session 的 /handoff：FAKE_HANDOFF_PRS 设了就替换（不是追加）默认的 prs。 */
const commandHandoff = () =>
  process.env.FAKE_HANDOFF_PRS ? { ...COMMAND_HANDOFF, prs: JSON.parse(process.env.FAKE_HANDOFF_PRS) } : COMMAND_HANDOFF;
/** feature 总控里键入 /handoff 时输出的 shipherd-feature-handoff。ticket 号故意写成小写，入库时规范成大写。 */
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
/** 演示剧本（FAKE_CLAUDE_SCRIPT，见文件开头）：{ banner?, rules: [{ when, reply?, then?: [{ after, line, say? }] }] }。 */
const SCRIPT = process.env.FAKE_CLAUDE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8")) : null;
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

/** 复盘分析的模式：FAKE_CLAUDE_LESSONS_FILE 的内容，每次重新读（e2e 中途会改）；没有这个文件就是 ok。 */
function lessonsMode() {
  const file = process.env.FAKE_CLAUDE_LESSONS_FILE;
  try {
    return (file ? fs.readFileSync(file, "utf8").trim() : "") || "ok";
  } catch {
    return "ok";
  }
}

/** review 经验的分析（--json-schema 里有 findings），按 lessonsMode 回答。 */
function lessonsAnalysis() {
  const mode = lessonsMode();
  log(`lessons ${mode}`);
  const result = (r) => process.stdout.write(`${JSON.stringify({ type: "result", ...r })}\n`);
  const limit = /^limit:(\d+)$/.exec(mode);
  if (mode === "ok") {
    // 不提炼规矩，回空的。
    const none = { findings: [] };
    result({ subtype: "success", is_error: false, session_id: `lessons-${Date.now()}`, result: JSON.stringify(none), structured_output: none, permission_denials: [], total_cost_usd: 0.0123, duration_ms: 1500, modelUsage: { "claude-fake-lessons": { inputTokens: 1200, outputTokens: 80, costUSD: 0.0123 } } });
  } else if (mode === "fail") {
    // 带 JSON 的失败：Shipherd 记成 claude_error，错误信息是 result，花费照记，stderr 也留下。
    result({ is_error: true, result: "boom", total_cost_usd: 0.0042 });
    process.stderr.write("fake lessons stderr: boom\n");
    process.exitCode = 1;
  } else if (limit) {
    result({ subtype: "success", is_error: true, result: `Claude AI usage limit reached|${limit[1]}`, session_id: "lessons-limit" });
    process.exitCode = 1;
  } else {
    process.stderr.write(`fake claude: unknown lessons mode ${JSON.stringify(mode)}\n`);
    process.exitCode = 2;
  }
}

/** 分叉讨论的用量：一轮读了开发 session 的缓存。 */
const FORK_USAGE = { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 50 };
/** 分叉讨论每一轮自己的花费；开发 session（fake claude 没记过它的累计）当它以前花过 FORK_PARENT_SPEND。 */
const FORK_RUN_COST = 0.02;
const FORK_PARENT_SPEND = 1;
/** 每个 session 的累计 total_cost_usd，记在运行记录旁边（每次分叉讨论是一个新进程）。 */
const forkTotalsFile = () => (process.env.FAKE_CLAUDE_LOG ? `${process.env.FAKE_CLAUDE_LOG}.fork-totals.json` : null);
/** 累计 total 对应的累计 modelUsage：每 FORK_RUN_COST 算一轮 FORK_USAGE 的 token（开发 session 以前的 1.00 就是 50 轮）。 */
function forkModelUsage(total) {
  const n = Math.round(total / FORK_RUN_COST);
  return {
    "claude-fake-fork": {
      inputTokens: FORK_USAGE.input_tokens * n,
      outputTokens: FORK_USAGE.output_tokens * n,
      cacheReadInputTokens: FORK_USAGE.cache_read_input_tokens * n,
      cacheCreationInputTokens: 0,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 0,
      costUSD: total,
    },
  };
}
function forkTotals() {
  const f = forkTotalsFile();
  try {
    return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  } catch {
    return {};
  }
}
/** 分叉讨论里要结论（prompt 的最后一行提到「结论」，即 conclusionAsk）时的回答。 */
const FORK_CONCLUSION = "结论：把 X 改成 Y";

/**
 * 分叉讨论（-p 不带 --json-schema）：运行记录写 fork-run <参数 JSON> 和 fork-session <回的 id>。
 * --fork-session 或者没有 --resume：一个新 id；只有 --resume X：接着 X（和真的 CLI 一样）。
 * total_cost_usd 也和真的 CLI 一样是累计的：没有 --resume 从 0 起；--resume X（带不带 --fork-session）从 X 的累计起，再加这一轮的 FORK_RUN_COST。
 * FAKE_CLAUDE_FORK=limit[:<秒级时间戳>]：照复盘分析 limit: 的写法回撞额度（没给时间就是一小时后），退出 1。
 */
function forkRun(input) {
  log(`fork-run ${JSON.stringify(args)}`);
  const mode = process.env.FAKE_CLAUDE_FORK || "";
  const limit = /^limit(?::(\d+))?$/.exec(mode);
  if (limit) {
    const at = limit[1] || String(Math.floor(Date.now() / 1000) + 3600);
    log(`fork-limit ${at}`);
    process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: `Claude AI usage limit reached|${at}`, session_id: "fork-limit" })}\n`);
    process.exitCode = 1;
    return;
  }
  const sessionId = has("--fork-session") || !has("--resume") ? randomUUID() : flag("--resume");
  log(`fork-session ${sessionId}`);
  const totals = forkTotals();
  const from = has("--resume") ? (totals[flag("--resume")] ?? FORK_PARENT_SPEND) : 0;
  const total = Math.round((from + FORK_RUN_COST) * 1e6) / 1e6;
  totals[sessionId] = total;
  if (forkTotalsFile()) fs.writeFileSync(forkTotalsFile(), JSON.stringify(totals));
  const last = input.trimEnd().split("\n").pop().trim();
  const result = /结论|conclusion/i.test(last) ? FORK_CONCLUSION : `分叉回答：${last}`;
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result, usage: FORK_USAGE, total_cost_usd: total, modelUsage: forkModelUsage(total), permission_denials: [] })}\n`);
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
    if (flag("--json-schema") === undefined) {
      forkRun(input);
      return;
    }
    let schema = {};
    try {
      schema = JSON.parse(flag("--json-schema") || "{}");
    } catch {
      // 按 handoff 处理。
    }
    const props = schema.properties || {};
    if (props.needs_user && input.includes(ASK_REPLY)) {
      // /fake-ask 的回复：说需要你，理由就是那句问话（判断失败时 Shipherd 不再看问号，BTL-190 第 2+3 点）。
      const verdict = { needs_user: true, reason: ASK_REPLY };
      log("needs-you judge: needed");
      process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: `judge-${Date.now()}`, result: JSON.stringify(verdict), structured_output: verdict, permission_denials: [], total_cost_usd: 0 })}\n`);
      return;
    }
    if (props.needs_user) {
      // 别的回复不假装 Haiku：判断失败，Shipherd 当作不需要你。FAKE_CLAUDE_JUDGE_DELAY_MS 让它像真的 Haiku 一样过一会儿才失败。
      setTimeout(() => {
        log("needs-you judge failed");
        process.stderr.write("fake claude does not judge needs-you\n");
        process.exitCode = 1;
      }, Number(process.env.FAKE_CLAUDE_JUDGE_DELAY_MS) || 0);
      return;
    }
    if (props.findings) {
      lessonsAnalysis();
      return;
    }
    if (props.enriched) {
      // 规矩补填（lesson_enrich，工作流 D）：prompt 里每条 "#id " 开头的规矩补一项；正文提到 console 的算能写成检查。
      const lines = [...input.matchAll(/^#(\d+) \[[^\]]*\] (.*)$/gm)];
      const enriched = lines.map((m) => ({
        id: Number(m[1]), globs: ["src/**"], lang: "ts", layer: null, strength: "should",
        checkability: /console/i.test(m[2]) ? "checkable" : "prose", checkability_reason: "fake enrich",
      }));
      log(`lesson enrich ${enriched.length}`);
      process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: `enrich-${Date.now()}`, result: JSON.stringify({ enriched }), structured_output: { enriched }, permission_denials: [], total_cost_usd: 0 })}\n`);
      return;
    }
    if (props.checkable) {
      // 从规矩起草检查（check_draft）：规矩里有 "prose" 就说写不成检查，否则给一条禁止 console.log( 的检查。
      const draft = /prose/i.test(input)
        ? { checkable: false, reason: "fake: needs judgement" }
        : { checkable: true, reason: "fake: a pattern is enough", check: { type: "forbidden_pattern", name: "no console.log", params: { pattern: "console\\.log\\(" }, globs: ["src/**"], severity: "block", message: "Use the logger instead." } };
      log(`check draft ${draft.checkable}`);
      process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: `draft-${Date.now()}`, result: JSON.stringify(draft), structured_output: draft, permission_denials: [], total_cost_usd: 0 })}\n`);
      return;
    }
    if (props.merges) {
      // 合并相似规矩（lesson_merge，BTL-274）：给的几条合成一条，文字是「合并：」加第一条。
      const lines = [...input.matchAll(/^#(\d+) \((.*?)\) (.*)$/gm)];
      const out = { merges: lines.length >= 2 ? [{ ids: lines.map((m) => Number(m[1])), text: `合并：${lines[0][3]}`, why: "fake merge" }] : [] };
      log(`lesson merge ${lines.length}`);
      process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: `merge-${Date.now()}`, result: JSON.stringify(out), structured_output: out, permission_denials: [], total_cost_usd: 0 })}\n`);
      return;
    }
    // 规矩准入的几步（工作流 D）：没有重复、没有冲突、都清楚、提到 console 的能写成检查、抽查都通过、不归原则。
    const admissionKey = ["groups", "conflicts", "clarity", "classified", "reviews", "principles"].find((k) => props[k]);
    if (admissionKey) {
      const ids = [...input.matchAll(/^#(\d+) \[[^\]]*\] (.*)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2] }));
      const answer = {
        groups: () => [],
        conflicts: () => [],
        principles: () => [],
        clarity: () => ids.map((l) => ({ id: l.id, answer: "yes", scope_clear: true, reason: "fake: clear" })),
        classified: () => ids.map((l) => ({ id: l.id, checkability: /console/i.test(l.text) ? "checkable" : "prose", reason: "fake classify", covered_by: null })),
        reviews: () => ids.map((l) => ({ id: l.id, reasonable: true, follows: true, scope_ok: true, note: "fake: fine" })),
      }[admissionKey]();
      const out = { [admissionKey]: answer };
      log(`admission ${admissionKey} ${ids.length}`);
      process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: `admission-${Date.now()}`, result: JSON.stringify(out), structured_output: out, permission_denials: [], total_cost_usd: 0 })}\n`);
      return;
    }
    // 预审三步（工作流 G）：预审（schema 里有 violations）回「没有违规」；交叉核对（items）每条都 consistent；
    // 简报摘要（只有 summary）回一句固定的话。运行记录各记一行。
    const reply = (tag, out) => process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: `${tag}-${Date.now()}`, result: JSON.stringify(out), structured_output: out, permission_denials: [], total_cost_usd: 0 })}\n`);
    if (props.violations) {
      log(`pre-review files=${(input.match(/^- \S+ \(\+\d+ -\d+\)$/gm) || []).length}`);
      // FAKE_CLAUDE_PREREVIEW_GATE 那个文件在时先不回答（e2e 看「预审中」、侧栏指示和队列页，删掉文件再放行）。
      const gate = process.env.FAKE_CLAUDE_PREREVIEW_GATE;
      const held = () => gate !== undefined && fs.existsSync(gate);
      const answer = () => (held() ? setTimeout(answer, 50) : reply("prereview", { violations: [], summary: "Fake pre-review: no rule is broken." }));
      if (held()) log("pre-review held");
      answer();
      return;
    }
    // 信息流转的抽要点（conv_relay，BTL-272）：items 的每一项有 quote。默认一条都不抽；FAKE_CLAUDE_FLOW_FILE 指向的文件存在时原样回它（每次重读）。
    const flowItem = props.items && props.items.items && props.items.items.properties;
    if (flowItem && flowItem.quote) {
      const file = process.env.FAKE_CLAUDE_FLOW_FILE;
      const out = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { items: [] };
      log(`infoflow extract ${out.items.length}`);
      reply("flow", out);
      return;
    }
    if (props.items && !props.summary) {
      const ids = [...input.matchAll(/^### id=(\d+) /gm)].map((m) => Number(m[1]));
      log(`evidence verify ${ids.length}`);
      reply("verify", { items: ids.map((id) => ({ id, verdict: "consistent", reason: "fake: matches the diff" })) });
      return;
    }
    if (props.summary && Object.keys(props).length === 1) {
      log("brief summary");
      reply("brief", { summary: "Fake brief: adds a greeting to the app." });
      return;
    }
    if (props.inferred_checks) {
      // 仓库现状的模型补全（repo_scan_infer）：回一条测试命令和一条 lint 命令；FAKE_CLAUDE_INFER=fail 时失败退出。
      log(`repo scan infer cwd=${process.cwd()}`);
      if (process.env.FAKE_CLAUDE_INFER === "fail") {
        process.stderr.write("fake infer failed\n");
        process.exitCode = 1;
        return;
      }
      const answer = {
        inferred_checks: [
          { dir: "", category: "test", tool: "check-sh", command: "./tools/check.sh", changedFiles: false, evidence: ".gitlab-ci.yml" },
          { dir: "", category: "lint", tool: "make-verify", command: "make verify", changedFiles: false, evidence: ".gitlab-ci.yml" },
        ],
        profiles: [{ dir: "", testAll: "./tools/check.sh", lint: "make verify", fastest: "make verify" }],
        notes: "fake: read the CI file",
      };
      process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: `infer-${Date.now()}`, result: JSON.stringify(answer), structured_output: answer, permission_denials: [], total_cost_usd: 0 })}\n`);
      return;
    }
    // prompt 的第一行有中文就当中文，否则英文（Shipherd 按界面语言出 prompt）。
    const lang = /[\u4e00-\u9fff]/.test(input.split("\n")[0]) ? "zh" : "en";
    const judge = !!props.stuck;
    // 整个 prompt 记下来：e2e 用它确认 Shipherd 真的读到了输出和子进程 CPU。
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

/** MCP Streamable HTTP 的一次 POST（共享 MCP，WS-M H）：JSON 进 JSON 出，通知回 202。 */
function httpRpc(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 202) resolve(null);
          else if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode} ${data}`));
          else resolve(JSON.parse(data));
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/**
 * 和 Claude Code 一样调用 shipherd-sessions 的一个工具。stdio：按配置启动 server，握手后调用；env 在继承的环境上叠加配置里的，SHIPHERD_SESSION 就是这样传下去的。
 * http（共享 MCP）：对配置里的 URL 握手、发 initialized、再调用。
 */
function callMcpTool(configPath, tool, input) {
  const server = JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers["shipherd-sessions"];
  if (server.type === "http") {
    const rpc = (id, method, params) => httpRpc(server.url, { jsonrpc: "2.0", id, method, params });
    return rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } })
      .then(() => httpRpc(server.url, { jsonrpc: "2.0", method: "notifications/initialized" }))
      .then(() => rpc(2, "tools/call", { name: tool, arguments: input }))
      .then((m) => m.result);
  }
  return new Promise((resolve, reject) => {
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
  /** 这一段对话的上下文大小，写进每条 assistant 记录的 usage（Shipherd 的 UsageScanner 读它）。 */
  let contextTokens = Number(process.env.FAKE_CLAUDE_CONTEXT_TOKENS) || CLEARED_CONTEXT;
  const usage = () => ({ input_tokens: contextTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 });
  const out = (s) => process.stdout.write(s.replace(/\n/g, "\r\n"));
  const append = (entry) => {
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.appendFileSync(transcript, `${JSON.stringify({ ...entry, sessionId, cwd, timestamp: new Date().toISOString() })}\n`);
  };
  const mcp = flag("--mcp-config");
  let servers = [];
  // shipherd-sessions 是 feature 模式（SHIPHERD_FEATURE）的才是 feature 总控：普通 ticket session 也挂 shipherd-sessions（只有 ask_user、report）。
  let featureCoordinator = false;
  /** /fake-nostop always 之后：每一轮都丢 Stop（BTL-279 review：回复的那一轮也没有 Stop）。 */
  let stopLost = false;
  const NOSTOP_FOOTER = ["  model: opus · ctx 41%", "  branch: main · +3 −1", "  cost: $0.42 today", "  PR #12 · CI green", "  ⏵⏵ accept edits on", "  ? for shortcuts"];
  /**
   * 空输入框：两条线按终端的宽度画（和 Claude Code 一样）。写死 60 字时，CI 的小屏幕上终端只有四十几列，线折成两行，
   * 认不出输入框，屏幕证据就校正不了。
   */
  const emptyBox = () => {
    const rule = "\u2500".repeat(Math.max(20, process.stdout.columns || 80));
    return `${rule}\n> \n${rule}\n${NOSTOP_FOOTER.join("\n")}\n`;
  };
  /** 上一次画的是丢了 Stop 的空输入框：终端改了尺寸就按新宽度重画（Claude Code 改尺寸时也整屏重画）。 */
  let boxShown = false;
  process.stdout.on("resize", () => {
    if (boxShown) out(emptyBox());
  });
  /** 写完这一轮的回复、画出空输入框（下面六行状态栏），不跑 Stop。transcript 里的回复也没有 stop_reason。 */
  const endWithoutStop = (text) => {
    append({ type: "assistant", uuid: `a-${Date.now()}`, message: { id: messageId(), role: "assistant", stop_reason: null, usage: usage(), content: [{ type: "text", text }] } });
    out(`${text}\n${emptyBox()}`);
    boxShown = true;
  };
  if (mcp) {
    try {
      const all = JSON.parse(fs.readFileSync(mcp, "utf8")).mcpServers || {};
      servers = Object.keys(all);
      // 共享 MCP 的配置里只有 URL，看不出是不是 feature 总控：按 ticket 的 handoff 回答（用共享 MCP 的 e2e 不需要 feature 的）。
      featureCoordinator = Boolean(all["shipherd-sessions"]?.env?.SHIPHERD_FEATURE);
      const types = [...new Set(Object.values(all).map((v) => v.type || "stdio"))];
      if (types.length) log(`mcp transport ${types.join(",")}`);
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
  log(`interactive ${has("--resume") ? "resume" : "new"} ${sessionId} mcp=${servers.join(",")} cwd=${cwd} adddirs=${flags("--add-dir").join("|")} guide=${flag("--append-system-prompt-file") || ""}`);
  // 交互 session 的模型（3.0 模型路由）另起一行，不改上面那行的格式。
  log(`interactive-model ${sessionId} ${flag("--model") || "-"}`);
  // --settings 里放行的工具（ws-j 权限档案）也另起一行。
  let allow = [];
  try {
    if (flag("--settings")) allow = JSON.parse(fs.readFileSync(flag("--settings"), "utf8")).permissions?.allow ?? [];
  } catch {
    // 读不到就当没有放行的工具。
  }
  log(`interactive-allow ${sessionId} ${JSON.stringify(allow)}`);
  runHooks("SessionStart", { session_id: sessionId, cwd, source: has("--resume") ? "resume" : "startup", transcript_path: transcript });
  if (SCRIPT && SCRIPT.banner) {
    out(`${SCRIPT.banner}\n`);
  } else {
    out(`fake claude ready (${sessionId.slice(0, 8)})\n`);
    if (mcp) out(`mcp: ${servers.join(", ")}\n`);
  }
  out("> ");
  /** assistant 记录的 message.id：和 Claude Code 一样每条回复一个（「需要你」按它每条只判断一次）。 */
  let messages = 0;
  let skillCalls = 0;
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
  /** 后台命令的 shell 子进程（Windows 上 Shipherd 不看进程树，不开）。 */
  let backgroundShell = null;
  const stopBackgroundShell = () => {
    if (backgroundShell) backgroundShell.kill();
    backgroundShell = null;
  };
  process.on("exit", stopBackgroundShell);
  /** 像 Claude Code 跑后台命令的 shell：命令行里带着命令，自己等着；假 claude 没了（被杀、没走到 exit 事件）它一秒内也退出。 */
  const startBackgroundShell = (command) => {
    stopBackgroundShell();
    if (process.platform === "win32") return;
    backgroundShell = spawn(SHELL, ["-c", 'while kill -0 "$PPID" 2>/dev/null; do sleep 1; done', command], { stdio: "ignore" });
    backgroundShell.on("error", (e) => log(`background shell error ${e.message}`));
  };
  const rl = readline.createInterface({ input: process.stdin });
  // bracketed paste（总控交任务时 Shipherd 这样写入）：粘贴里的几行合成一条消息。PTY 按行交付，粘贴结束标记所在的那一行
  // 只有等到 Shipherd 随后的回车才会到，所以读到结束标记就提交。
  let pasting = null;
  let pasted = null;
  /** 剧本排进来的输入（行 → 这一步的 say）：不算用户说的话。 */
  const scripted = new Map();
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
    boxShown = false;
    // 每条收到的输入都记一笔（JSON 字符串）：e2e 按顺序核对 Shipherd 往终端里输入了什么，屏幕上的早已滚走。
    log(`prompt ${JSON.stringify(line)}`);
    const step = scripted.get(line);
    scripted.delete(line);
    const rule = !step && SCRIPT ? (SCRIPT.rules || []).find((r) => line.includes(r.when)) : undefined;
    if (rule) {
      for (const t of rule.then || []) {
        setTimeout(() => {
          scripted.set(t.line, { say: t.say });
          rl.emit("line", t.line);
        }, t.after || 0);
      }
    }
    if (line === "exit") {
      runHooks("SessionEnd", { session_id: sessionId, cwd, reason: "exit", transcript_path: transcript });
      process.exit(0);
    }
    const later = /^\/fake-later (\d+) (.+)$/.exec(line);
    if (later) {
      setTimeout(() => rl.emit("line", later[2]), Number(later[1]));
      out("> ");
      return;
    }
    if (line === "/fake-links") {
      // OSC 8：ESC ] 8 ; ; <URL> ESC \ <显示的文字> ESC ] 8 ; ; ESC \（Claude Code 输出的就是这种）。
      const osc8 = (url, text) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
      out(`${osc8("https://example.com/osc8-target?from=fake", "osc8-link-text")}\n`);
      out("https://example.com/plain-url\n");
      out(`${osc8("file:///etc/passwd", "file-link-text")}\n> `);
      return;
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
      // Claude Code 的 /clear：新的 session id 和 transcript，SessionStart 的 source 是 clear；SHIPHERD_SESSION 不变，Shipherd 按它把新 id 接到这个终端上。
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
      stopBackgroundShell();
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
    } else if (!step) {
      append({ type: "user", message: { role: "user", content: line } });
    }
    if (!step) runHooks("UserPromptSubmit", { session_id: sessionId, cwd, prompt: line, transcript_path: transcript });
    if (rule) {
      if (rule.reply !== undefined) {
        append({ type: "assistant", uuid: `a-${Date.now()}`, message: { id: messageId(), role: "assistant", stop_reason: "end_turn", usage: usage(), content: [{ type: "text", text: rule.reply }] } });
        out(`${rule.reply}\n`);
        runHooks("Stop", { session_id: sessionId, cwd, stop_hook_active: false, transcript_path: transcript });
        out("> ");
      }
      return;
    }
    if (bash && bash[1] === "bash") {
      // 前台命令在跑：没有结果，这一轮不结束，也不打印新的提示符。
      startBash(bash[2], {});
      out("running\n");
      return;
    }
    const limitText = /^\/fake-limit (.+)$/.exec(line);
    if (limitText) {
      // Claude Code 撞了额度：一条它自己合成的报错（不是模型说的），这一轮以 turn_duration 结束，没有 Stop。
      append({ type: "assistant", uuid: `a-${Date.now()}`, isApiErrorMessage: true, message: { id: messageId(), role: "assistant", model: "<synthetic>", content: [{ type: "text", text: limitText[1] }] } });
      append({ type: "system", subtype: "turn_duration", durationMs: 1 });
      log(`fake-limit ${limitText[1]}`);
      out(`${limitText[1]}\n> `);
      return;
    }
    const fakeTool = /^\/fake-tool (\S+)(?: (.+))?$/.exec(line);
    if (fakeTool) {
      // 工具调用完了、模型还在想：这一轮不结束，也不跑 Stop。
      const toolId = `toolu-${Date.now()}-${messages}`;
      append({ type: "assistant", uuid: `a-${Date.now()}`, message: { id: messageId(), role: "assistant", stop_reason: "tool_use", usage: usage(), content: [{ type: "tool_use", id: toolId, name: fakeTool[1], input: fakeTool[2] ? JSON.parse(fakeTool[2]) : {} }] } });
      append({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] } });
      const input = fakeTool[2] ? JSON.parse(fakeTool[2]) : {};
      const outputs = runHooks("PostToolUse", { session_id: sessionId, cwd, tool_name: fakeTool[1], tool_input: input, tool_use_id: toolId, tool_response: "ok", transcript_path: transcript });
      for (const o of outputs) {
        try {
          const ctx = JSON.parse(o).hookSpecificOutput?.additionalContext;
          if (typeof ctx === "string" && ctx) log(`additional-context ${ctx.replace(/\r?\n/g, " ⏎ ")}`);
        } catch {
          // 不是 JSON：没有附加上下文。
        }
      }
      out(`tool ${fakeTool[1]}\n`);
      return;
    }
    const work = /^\/fake-work (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (work) {
      const until = Date.now() + Number(work[1]) * 1000;
      const every = Math.max(20, Number(work[2]));
      let n = 0;
      // 第三个数（BTL-277）：每隔这么多毫秒像 claude 的 spinner 那样重画一行（同步输出包着、回到行首、清行），一小块一次写。
      const spinEvery = work[3] ? Math.max(10, Number(work[3])) : 0;
      let spin = 0;
      const spinner = spinEvery ? setInterval(() => {
        spin += 1;
        process.stdout.write(`\x1b[?2026h\r\x1b[2K\x1b[38;2;215;119;87m${"✻✶✳✢·"[spin % 5]}\x1b[39m Working… (${Math.floor(spin * spinEvery / 1000)}s · esc to interrupt)\x1b[?2026l`);
      }, spinEvery) : null;
      const tick = () => {
        if (Date.now() >= until) {
          if (spinner) clearInterval(spinner);
          process.stdout.write("\r\x1b[2K");
          endTurnLater(`做完了 ${n} 步`);
          return;
        }
        n += 1;
        const toolId = `toolu-w-${process.pid}-${n}`;
        append({ type: "assistant", uuid: `a-${Date.now()}-${n}`, message: { id: messageId(), role: "assistant", stop_reason: "tool_use", usage: usage(), content: [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: path.join(cwd, `src/file-${n % 50}.ts`) } }] } });
        append({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "x".repeat(400) }] } });
        let text = "";
        for (let i = 0; i < 20; i++) text += `\x1b[32mwork ${n}.${i}\x1b[0m ${"=".repeat(90)}\n`;
        out(text);
        setTimeout(tick, every);
      };
      out("working\n");
      setTimeout(tick, every);
      return;
    }
    if (bash) {
      const { toolId, taskId, output } = startBash(bash[2], { run_in_background: true });
      backgroundTask = taskId;
      startBackgroundShell(bash[2]);
      append({ type: "user", toolUseResult: { backgroundTaskId: taskId }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `Command running in background with ID: ${taskId}. Output is being written to: ${output}. You will be notified when it completes \u2014 do not poll that file or sleep while waiting.` }] } });
    }
    function endTurnLater(said) {
      const reply = step && step.say !== undefined ? step.say : said;
      if (stopLost) return endWithoutStop(reply);
      append({ type: "assistant", uuid: `a-${Date.now()}`, message: { id: messageId(), role: "assistant", stop_reason: "end_turn", usage: usage(), content: [{ type: "text", text: reply }] } });
      out(`${reply}\n`);
      runHooks("Stop", { session_id: sessionId, cwd, stop_hook_active: false, transcript_path: transcript });
      out("> ");
    }
    // 写结束这一轮的回复、跑 Stop（函数声明会提升：/fake-work 的定时器在前面就用到它）。
    const endTurn = endTurnLater;
    const nostop = /^\/fake-nostop( always)? (.+)$/.exec(line);
    if (nostop) {
      // 像 Claude Code 丢了 Stop（BTL-279）：写完这一轮的回复、画出空输入框，但不跑 Stop hook。记录一直说它在干活；
      // transcript 里也认不出这一轮结束了，只剩屏幕能看出它停了。输入框下面六行状态栏（Shipherd 原来只认四行以内的）。
      if (nostop[1]) stopLost = true;
      endWithoutStop(nostop[2]);
      return;
    }
    const edit = /^\/fake-edit (\S+) (.+)$/.exec(line);
    if (edit) {
      // 像 Write 工具：先写文件，再跑 PostToolUse；tool_response 和 Claude Code 的一样带 originalFile（新文件是 create）。
      const file = path.resolve(cwd, edit[1]);
      const content = JSON.parse(edit[2]);
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      const outputs = runHooks("PostToolUse", {
        session_id: sessionId, cwd, tool_name: "Write", tool_input: { file_path: file, content }, transcript_path: transcript,
        tool_response: before === null ? { type: "create", filePath: file, content } : { type: "update", filePath: file, content, originalFile: before },
      });
      const flat = (t) => String(t).replace(/\r?\n/g, " ⏎ ");
      let said = false;
      for (const o of outputs) {
        try {
          const j = JSON.parse(o);
          if (j.decision === "block") {
            log(`check block ${flat(j.reason)}`);
            out(`blocked: ${j.reason}\n`);
            said = true;
          } else if (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) {
            log(`check note ${flat(j.hookSpecificOutput.additionalContext)}`);
            out(`note: ${j.hookSpecificOutput.additionalContext}\n`);
            said = true;
          }
        } catch {
          // 没有输出：检查通过。
        }
      }
      if (!said) log(`check pass ${edit[1]}`);
      endTurn(`写好了 ${edit[1]}`);
      return;
    }
    const skill = /^\/fake-skill (\S+)$/.exec(line);
    if (skill) {
      // 像 Skill 工具：PostToolUse 带 tool_use_id（Shipherd 按它去重）。
      runHooks("PostToolUse", { session_id: sessionId, cwd, tool_name: "Skill", tool_input: { skill: skill[1] }, tool_use_id: `toolu_fake_${process.pid}_${++skillCalls}`, transcript_path: transcript });
      log(`fake-skill ${skill[1]}`);
      out(`skill ${skill[1]}\n`);
      endTurn("收到");
      return;
    }
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
      // 工具在等 Shipherd 回话，这一轮结束不了；结果记下来给 e2e 读，终端里的文字会被折行。
      callMcpTool(mcp, tool[1], tool[2] ? JSON.parse(tool[2]) : {}).then(
        (result) => {
          log(`mcp result ${JSON.stringify(result)}`);
          endTurn(`工具返回：${tool[1]}`);
        },
        (e) => endTurn(`工具失败：${e.message}`),
      );
      return;
    }
    if (line === "/fake-recall") {
      // 像模型回忆这段对话：把 transcript 里用户说过的话列出来（--resume 接着同一个 transcript，休眠前说的也在）。
      let said = [];
      try {
        said = fs.readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
          .filter((e) => e.type === "user" && !e.isMeta && typeof e.message?.content === "string" && e.message.content !== "/fake-recall")
          .map((e) => e.message.content);
      } catch {
        // 还没有 transcript。
      }
      log(`fake-recall ${JSON.stringify(said)}`);
      endTurn(`记得：${said.join(" | ")}`);
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
          ? `handoff：\n\n\`\`\`shipherd-feature-handoff\n${JSON.stringify(featureHandoff, null, 2)}\n\`\`\``
          : `handoff：\n\n\`\`\`shipherd-handoff\n${JSON.stringify(commandHandoff(), null, 2)}\n\`\`\``);
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
