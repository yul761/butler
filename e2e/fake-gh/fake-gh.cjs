#!/usr/bin/env node
// E2E 用的假 gh（计划 2026-11-16 任务 19）。只实现 Butler 的 PR 监视、补链接和复盘分析用到的部分，绝不联网：
//   每次调用都重新读 FAKE_GH_FIXTURE 指向的 JSON（测试中途可以改）：{ branches: { <分支>: [pr list 的项] }, prs: { <PR 链接，prUrlKey 形式>: pr view 的结果 } }；
//   每次调用把参数（JSON 数组）追加一行到 FAKE_GH_LOG；
//   --version；
//   pr list --head <分支> --state all …：branches[分支]，没有就是 []；
//   pr list --state merged …（复盘的补录、每日拉取）：没有已合并的 PR（[]；带 --jq .[] 时就是没有输出）；
//   pr view <链接或分支> --json …：prs[prUrlKey(参数)]，没有就退出 1（--json 的字段不筛，原样输出）；
//   pr view <号> --json …（复盘分析）：prs 里链接以 /pull/<号> 结尾的第一项，没有就退出 1；
//   pr create …：打印 fixture 的 created（新 PR 的链接，像真 gh 一样一行），没有就记 unsupported；
//   run list --branch <分支> …：[]；
//   api repos/{owner}/{repo}/pulls/<n>/comments 和 …/pulls/<n>/reviews：没有输出（行内评论、review 列表都是空的）；
//   评论闭环和 CI 分类（工作流 I）：
//     api graphql … number=<n> -f query=query…reviewThreads…：threads[<n>]（GraphQL 的 thread 节点数组），没有就是 []；
//     api graphql -f id=<thread> -f query=mutation…resolveReviewThread…：成功（调用记在 FAKE_GH_LOG 里，测试据此断言）；
//     api repos/{owner}/{repo}/pulls/<n>/comments/<id>/replies、…/issues/<n>/comments（-f body=…）：打印 {html_url}；
//     api repos/{owner}/{repo}/compare/<base>...<head> --jq …：compare 里每个文件一行 {filename, patch}，没有就是没有输出；
//     run view <id> --json …：runs[<id>]，没有就退出 1；run view <id> --log-failed：logs[<id>]，没有就退出 1；
//     run rerun <id> --failed：成功；
//   其余一律退出 1，并往 FAKE_GH_LOG 追加一行 {"unsupported": 参数}：测试结束时 unsupportedGhCalls 会把它们找出来，
//   免得产品调了假 gh 不认的命令却被当成"gh 出错"悄悄吞掉。
"use strict";
const fs = require("node:fs");

const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);

/** 和 src/shared/pr-url.ts 的 prUrlKey 一样：去掉首尾空白和末尾斜杠，小写。 */
const prUrlKey = (url) => url.trim().replace(/\/+$/, "").toLowerCase();
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fixture = () => {
  const f = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, "utf8"));
  return { branches: f.branches ?? {}, prs: f.prs ?? {}, created: f.created ?? null, threads: f.threads ?? {}, runs: f.runs ?? {}, logs: f.logs ?? {}, compare: f.compare ?? [] };
};
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
/** fixture 里没有：和真 gh 一样退出 1，是正常结果，不记 unsupported。 */
const notFound = (msg) => {
  process.stderr.write(`fake gh: ${msg}\n`);
  process.exit(1);
};
/** 假 gh 不认的调用：记一行 unsupported，再退出 1。 */
const unsupported = () => {
  if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ unsupported: args })}\n`);
  process.stderr.write(`fake gh: unsupported: ${args.join(" ")}\n`);
  process.exit(1);
};
const API_PULL = /^repos\/\{owner\}\/\{repo\}\/pulls\/\d+\/(comments|reviews)$/;
const API_REPLY = /^repos\/\{owner\}\/\{repo\}\/(pulls\/\d+\/comments\/\d+\/replies|issues\/\d+\/comments)$/;
const API_COMPARE = /^repos\/\{owner\}\/\{repo\}\/compare\/[^/]+\.\.\.[^/]+$/;
/** -f / -F 传的 key=value。 */
const field = (key) => {
  for (let i = 0; i < args.length - 1; i++) if ((args[i] === "-f" || args[i] === "-F") && args[i + 1].startsWith(`${key}=`)) return args[i + 1].slice(key.length + 1);
  return undefined;
};

const [cmd, sub, ref] = args;
if (cmd === "--version") {
  process.stdout.write("gh version 2.83.0 (fake)\n");
} else if (cmd === "pr" && sub === "list" && flag("--head") !== undefined && flag("--state") === "all") {
  out(fixture().branches[flag("--head")] ?? []);
} else if (cmd === "pr" && sub === "list" && flag("--state") === "merged") {
  if (flag("--jq") !== ".[]") out([]);
} else if (cmd === "pr" && sub === "view" && ref !== undefined && !ref.startsWith("-") && args.includes("--json")) {
  const prs = fixture().prs;
  const pr = /^\d+$/.test(ref) ? Object.entries(prs).find(([url]) => url.endsWith(`/pull/${ref}`))?.[1] : prs[prUrlKey(ref)];
  if (!pr) notFound(`no pull requests found for ${ref}`);
  out(pr);
} else if (cmd === "pr" && sub === "create" && fixture().created) {
  process.stdout.write(`${fixture().created}\n`);
} else if (cmd === "run" && sub === "list" && flag("--branch") !== undefined) {
  out([]);
} else if (cmd === "api" && API_PULL.test(sub ?? "")) {
  // 行内评论、review 列表：没有。
} else if (cmd === "api" && sub === "graphql" && /^\s*query/.test(field("query") ?? "") && field("number") !== undefined) {
  out({ data: { repository: { pullRequest: { reviewThreads: { nodes: fixture().threads[field("number")] ?? [] } } } } });
} else if (cmd === "api" && sub === "graphql" && /^\s*mutation/.test(field("query") ?? "") && field("id") !== undefined) {
  out({ data: { resolveReviewThread: { thread: { id: field("id"), isResolved: true } } } });
} else if (cmd === "api" && API_REPLY.test(sub ?? "") && field("body") !== undefined) {
  out({ html_url: "https://github.com/acme/app/pull/0#fake-reply" });
} else if (cmd === "api" && API_COMPARE.test(sub ?? "")) {
  for (const f of fixture().compare) out({ filename: f.filename, patch: f.patch ?? "" });
} else if (cmd === "run" && sub === "view" && /^\d+$/.test(ref ?? "") && args.includes("--log-failed")) {
  const log = fixture().logs[ref];
  if (log === undefined) notFound(`no failed log for run ${ref}`);
  process.stdout.write(`${log}\n`);
} else if (cmd === "run" && sub === "view" && /^\d+$/.test(ref ?? "") && args.includes("--json")) {
  const run = fixture().runs[ref];
  if (!run) notFound(`run ${ref} not found`);
  out(run);
} else if (cmd === "run" && sub === "rerun" && /^\d+$/.test(ref ?? "") && args.includes("--failed")) {
  process.stdout.write(`✓ Requested rerun of run ${ref}\n`);
} else {
  unsupported();
}
