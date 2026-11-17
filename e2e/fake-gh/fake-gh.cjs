#!/usr/bin/env node
// E2E 用的假 gh（计划 2026-11-16 任务 19）。只实现 Butler 的 PR 监视和补链接用到的部分，绝不联网：
//   每次调用都重新读 FAKE_GH_FIXTURE 指向的 JSON（测试中途可以改）：{ branches: { <分支>: [pr list 的项] }, prs: { <PR 链接，prUrlKey 形式>: pr view 的结果 } }；
//   每次调用把参数（JSON 数组）追加一行到 FAKE_GH_LOG；
//   --version；
//   pr list --head <分支> --state all …：branches[分支]，没有就是 []；
//   pr view <链接或分支> --json …：prs[prUrlKey(参数)]，没有就退出 1（--json 的字段不筛，原样输出）；
//   run list …：[]；
//   api …：没有输出；
//   其余一律退出 1。
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
  return { branches: f.branches ?? {}, prs: f.prs ?? {} };
};
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const fail = (msg) => {
  process.stderr.write(`fake gh: ${msg}\n`);
  process.exit(1);
};

const [cmd, sub, ref] = args;
if (cmd === "--version") {
  process.stdout.write("gh version 2.83.0 (fake)\n");
} else if (cmd === "pr" && sub === "list" && flag("--head") !== undefined && flag("--state") === "all") {
  out(fixture().branches[flag("--head")] ?? []);
} else if (cmd === "pr" && sub === "view" && ref !== undefined && !ref.startsWith("-") && args.includes("--json")) {
  const pr = fixture().prs[prUrlKey(ref)];
  if (!pr) fail(`no pull requests found for ${ref}`);
  out(pr);
} else if (cmd === "run" && sub === "list") {
  out([]);
} else if (cmd === "api") {
  // 行内评论、review 列表：没有。
} else {
  fail(`unsupported: ${args.join(" ")}`);
}
