#!/usr/bin/env node
// E2E 用的假 gh（计划 2026-11-16 任务 19）。只实现 Shipherd 的 PR 监视、补链接和复盘分析用到的部分，绝不联网：
//   每次调用都重新读 FAKE_GH_FIXTURE 指向的 JSON（测试中途可以改）：{ branches: { <分支>: [pr list 的项] }, prs: { <PR 链接，prUrlKey 形式>: pr view 的结果 } }；
//   每次调用把参数（JSON 数组）追加一行到 FAKE_GH_LOG；
//   --version；
//   auth token（BTL-249，环境检查看 gh 登没登录）：fixture 的 loggedOut 为 true 时退出 1，否则打印一个假 token；
//   search prs --review-requested=@me --state=open …（UI 重做第 1 层，请你 review 的 PR）：reviewRequested，没有就是 []；
//   pr list --head <分支> --state all …：branches[分支]，没有就是 []；
//   pr list --state merged …（复盘的补录、每日拉取）：没有已合并的 PR（[]；带 --jq .[] 时就是没有输出）；
//   pr view <链接或分支> --json …：prs[prUrlKey(参数)]（--json 的字段不筛，原样输出）。没有时和真 gh 一样退出 1：链接的仓库下一个 PR 都没有，
//     报仓库解析不到；有这个仓库、没这个号，报 PR 解析不到（和批量读的错误一样）；分支报 no pull requests found；
//   pr view <号> --json …（复盘分析）：prs 里链接以 /pull/<号> 结尾的第一项，没有就报 PR 解析不到、退出 1；
//   pr create …：打印 fixture 的 created（新 PR 的链接，像真 gh 一样一行），没有就记 unsupported；
//   run list --branch <分支> …：[]；
//   api repos/{owner}/{repo}/pulls/<n>/comments 和 …/pulls/<n>/reviews：没有输出（行内评论、review 列表都是空的）；
//   评论闭环和 CI 分类（工作流 I）：
//     api graphql … number=<n> -f query=query…reviewThreads…：threads[<n>]（GraphQL 的 thread 节点数组），没有就是 []；
//     api graphql -f id=<thread> -f query=mutation…resolveReviewThread…：成功（调用记在 FAKE_GH_LOG 里，测试据此断言）；
//     api repos/{owner}/{repo}/pulls/<n>/comments/<id>/replies、…/issues/<n>/comments（-f body=…）：打印 {html_url}；
//     api repos/{owner}/{repo}/compare/<base>...<head> --jq …：compare 里每个文件一行 {filename, patch}，没有就是没有输出；
//     api repos/{owner}/{repo}/pulls/<n>/files --paginate --jq .[].filename：files[<n>] 每个文件名一行，没有就是没有输出；
//     run view <id> --json …：runs[<id>]，没有就退出 1；run view <id> --log-failed：logs[<id>]，没有就退出 1；
//     run rerun <id> --failed：成功；
//   栈（工作流 K）：
//     pr list --state open …（不带 --head，自动检测栈）：fixture 的 open（pr view 字段的数组），没有就是 []；
//     pr edit <号> --base/--title/--body-file/--add-label/--remove-label …、pr ready <号>、pr close <号> …、issue edit <号> …：成功
//       （假 gh 不改 fixture，测试据 FAKE_GH_LOG 断言；要后续读到新状态就自己 setGh）；
//     label create <名字> …：成功；issue create …：打印 fixture 的 issueCreated（没有就是 …/issues/900）；
//   更新提示（BTL-253）：
//     api repos/<owner>/<repo>/releases/latest：fixture 的 release（GitHub releases API 的字段：tag_name、html_url、body、draft、prerelease、published_at），
//       没有就和真 gh 一样打 HTTP 404 退出 1（还没发布过 release）；
//   批量读 PR（BTL-276）：
//     api graphql -f query=…p<号>: pullRequest(number: <号>)… -f owner=… -f name=…：每个别名从 prs 里找（链接以 /<owner>/<name>/pull/<号> 结尾），
//       转成 GraphQL 节点（updatedAt 用 fixture 给的；没给就是那份 fixture 除了 CI、合并状态以外的指纹：和真 GitHub 一样，
//       CI、合并状态变了 updatedAt 不变，要靠检查的 id / 结果看出来）；查询里有 allReviews: 时给全部字段。没有的 PR 和真 GitHub 一样：
//       别名为 null、errors 里一条 NOT_FOUND，JSON 照打、退出 1；fixture 里一个 PR 都不在 <owner>/<name> 下：repository 为 null、
//       errors 里一条 path ["repository"] 的 NOT_FOUND（仓库解析不到），退出 1。
//       PR 的 fakeTotals（{comments, reviews, labels, reviewRequests} 的总数）和 fakeChecksHasNextPage：列表比给出来的长
//       （totalCount 用它、检查有下一页），用来测「列表太长、批量读不全，退回 gh pr view」；这两个字段 pr view 不输出；
//     api <路径> -i [-H If-None-Match: <etag>]（带 ETag 的 REST）：…/pulls/<n>/comments|reviews?per_page=100 是 []，…/actions/runs?… 是 {workflow_runs: []}；
//       头里带 Etag（内容的指纹），If-None-Match 对上了回 304（头照打、退出 1），和真 gh 一样；
//   仓库改名（BTL-261）：
//     repo view <owner/repo> --json nameWithOwner：fixture 的 renames[小写 slug]（改名后的名字），没有就是它自己（没改过名）；
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
  return { loggedOut: f.loggedOut === true, branches: f.branches ?? {}, prs: f.prs ?? {}, created: f.created ?? null, threads: f.threads ?? {}, runs: f.runs ?? {}, logs: f.logs ?? {}, compare: f.compare ?? [], files: f.files ?? {}, open: f.open ?? [], release: f.release ?? null, renames: f.renames ?? {}, reviewRequested: f.reviewRequested ?? [], issueCreated: f.issueCreated ?? "https://github.com/acme/app/issues/900" };
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
const API_PR_FILES = /^repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)\/files$/;
const API_RELEASE_LATEST = /^repos\/[^/{}]+\/[^/{}]+\/releases\/latest$/;
const API_COMPARE = /^repos\/\{owner\}\/\{repo\}\/compare\/\S+\.\.\.\S+$/; // 分支名可以带 /（feature/x）
/** -f / -F 传的 key=value。 */
const field = (key) => {
  for (let i = 0; i < args.length - 1; i++) if ((args[i] === "-f" || args[i] === "-F") && args[i + 1].startsWith(`${key}=`)) return args[i + 1].slice(key.length + 1);
  return undefined;
};

const crypto = require("node:crypto");
const hash = (v) => crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const API_PULL_PAGE = /^repos\/\{owner\}\/\{repo\}\/pulls\/\d+\/(comments|reviews)\?per_page=100$/;
const API_RUNS = /^repos\/\{owner\}\/\{repo\}\/actions\/runs\?branch=[^&]+&per_page=20$/;
/** gh api -i：状态行、头、空行、正文；带的 If-None-Match 对上了回 304。 */
const http = (body) => {
  const etag = `"${hash(body)}"`;
  const h = flag("-H");
  if (h !== undefined && h.replace(/^If-None-Match:\s*/i, "") === etag) {
    process.stdout.write(`HTTP/2.0 304 Not Modified\nEtag: ${etag}\n\n`);
    process.stderr.write("gh: HTTP 304\n");
    process.exit(1);
  }
  process.stdout.write(`HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\nEtag: ${etag}\n\n${JSON.stringify(body)}`);
};
/** gh pr view 形状的 fixture → GraphQL 的 PullRequest 节点（prBatch 读的形状）。 */
const prNode = (pr, full) => {
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const stateOf = (c) => (c.__typename === "StatusContext" ? String(c.state || "PENDING").toUpperCase() : String(c.status).toUpperCase() !== "COMPLETED" ? "PENDING" : String(c.conclusion || "SUCCESS").toUpperCase());
  const bad = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
  const states = checks.map(stateOf);
  const rollupState = states.some((x) => bad.has(x)) ? "FAILURE" : states.some((x) => x === "PENDING") ? "PENDING" : "SUCCESS";
  const rest = { ...pr };
  for (const k of ["statusCheckRollup", "mergeable", "mergeStateStatus"]) delete rest[k];
  const list = (v) => (Array.isArray(v) ? v : []);
  const totals = pr.fakeTotals ?? {};
  const total = (k, v) => (typeof totals[k] === "number" ? totals[k] : list(v).length);
  const requested = list(pr.reviewRequests).map((x) => ({ requestedReviewer: { __typename: x.slug ? "Team" : "User", ...x } }));
  // check run 的 id：链接里的 job id，没有就按内容算一个（重跑换了结果 / 链接就换 id）。
  const idOf = (c) => Number(/\/job\/(\d+)/.exec(c.detailsUrl ?? "")?.[1] ?? parseInt(hash(c).slice(0, 8), 16));
  const ids = checks.map((c) => (c.__typename === "StatusContext" ? { __typename: "StatusContext", context: c.context, state: c.state } : { __typename: "CheckRun", databaseId: idOf(c), status: c.status, conclusion: c.conclusion ?? null }));
  const node = {
    number: pr.number, url: pr.url, state: pr.state, updatedAt: pr.updatedAt ?? `fake-${hash(rest)}`, lastEditedAt: pr.lastEditedAt ?? null,
    headRefOid: pr.headRefOid, headRefName: pr.headRefName ?? "", baseRefName: pr.baseRefName ?? null, title: pr.title ?? null, isDraft: pr.isDraft === true,
    reviewDecision: pr.reviewDecision ?? null, mergeable: pr.mergeable ?? null, mergeStateStatus: pr.mergeStateStatus ?? null,
    comments: { totalCount: total("comments", pr.comments) }, reviews: { totalCount: total("reviews", pr.reviews) },
    labelCount: { totalCount: total("labels", pr.labels) },
    requested: { totalCount: total("reviewRequests", pr.reviewRequests), nodes: requested.slice(0, 20) },
    recentComments: { nodes: list(pr.comments).slice(-20).map((c) => ({ id: c.id ?? null, lastEditedAt: c.lastEditedAt ?? null })) },
    recentReviews: { nodes: list(pr.reviews).slice(-20).map((r) => ({ id: r.id ?? null, state: r.state ?? null, lastEditedAt: r.lastEditedAt ?? null })) },
    tip: { nodes: [{ commit: { statusCheckRollup: checks.length === 0 ? null : { state: rollupState, contexts: { totalCount: checks.length, nodes: ids } } } }] },
  };
  if (!full) return node;
  return {
    ...node, createdAt: pr.createdAt ?? null, mergedAt: pr.mergedAt ?? null, closedAt: pr.closedAt ?? null,
    body: pr.body ?? null, author: pr.author ?? null,
    labels: { totalCount: total("labels", pr.labels), nodes: list(pr.labels) },
    reviewRequests: { totalCount: total("reviewRequests", pr.reviewRequests), nodes: requested },
    allReviews: { totalCount: total("reviews", pr.reviews), nodes: list(pr.reviews) },
    allComments: { totalCount: total("comments", pr.comments), nodes: list(pr.comments) },
    commits: { nodes: list(pr.commits).map((c) => ({ commit: c })) },
    head: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: pr.fakeChecksHasNextPage === true }, nodes: checks } } } }] },
  };
};

const [cmd, sub, ref] = args;
if (cmd === "--version") {
  process.stdout.write("gh version 2.83.0 (fake)\n");
} else if (cmd === "auth" && sub === "token") {
  if (fixture().loggedOut) notFound("no oauth token found for github.com");
  process.stdout.write("gho_fake\n");
} else if (cmd === "search" && sub === "prs" && args.includes("--review-requested=@me")) {
  out(fixture().reviewRequested);
} else if (cmd === "pr" && sub === "list" && flag("--head") !== undefined && flag("--state") === "all") {
  out(fixture().branches[flag("--head")] ?? []);
} else if (cmd === "pr" && sub === "list" && flag("--state") === "merged") {
  if (flag("--jq") !== ".[]") out([]);
} else if (cmd === "pr" && sub === "view" && ref !== undefined && !ref.startsWith("-") && args.includes("--json")) {
  const prs = fixture().prs;
  const pr = /^\d+$/.test(ref) ? Object.entries(prs).find(([url]) => url.endsWith(`/pull/${ref}`))?.[1] : prs[prUrlKey(ref)];
  if (!pr) {
    const link = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(ref);
    if (link && !Object.keys(prs).some((u) => u.includes(`/${link[1]}/${link[2]}/pull/`.toLowerCase()))) notFound(`GraphQL: Could not resolve to a Repository with the name '${link[1]}/${link[2]}'. (repository)`);
    if (link || /^\d+$/.test(ref)) notFound(`GraphQL: Could not resolve to a PullRequest with the number of ${link ? link[3] : ref}. (repository.pullRequest)`);
    notFound(`no pull requests found for branch "${ref}"`);
  }
  const shown = { ...pr };
  delete shown.fakeTotals;
  delete shown.fakeChecksHasNextPage;
  out(shown);
} else if (cmd === "pr" && sub === "create" && fixture().created) {
  process.stdout.write(`${fixture().created}\n`);
} else if (cmd === "pr" && sub === "list" && flag("--head") === undefined && flag("--state") === "open") {
  out(fixture().open);
} else if (cmd === "pr" && sub === "edit" && /^\d+$/.test(ref ?? "") && ["--base", "--title", "--body-file", "--add-label", "--remove-label"].some((f) => args.includes(f))) {
  process.stdout.write(`https://github.com/acme/app/pull/${ref}\n`);
} else if (cmd === "pr" && (sub === "ready" || sub === "close") && /^\d+$/.test(ref ?? "")) {
  // 成功：真 gh 打一行提示，Shipherd 不读。
} else if (cmd === "label" && sub === "create" && ref !== undefined && !ref.startsWith("-")) {
  // 成功
} else if (cmd === "issue" && sub === "create" && args.includes("--title")) {
  process.stdout.write(`${fixture().issueCreated}\n`);
} else if (cmd === "issue" && sub === "edit" && /^\d+$/.test(ref ?? "")) {
  process.stdout.write(`https://github.com/acme/app/issues/${ref}\n`);
} else if (cmd === "repo" && sub === "view" && /^[^/\s-][^/\s]*\/[^/\s]+$/.test(ref ?? "") && flag("--json") === "nameWithOwner") {
  out({ nameWithOwner: fixture().renames[ref.toLowerCase()] ?? ref });
} else if (cmd === "run" && sub === "list" && flag("--branch") !== undefined) {
  out([]);
} else if (cmd === "api" && API_RELEASE_LATEST.test(sub ?? "") && args.length === 2) {
  const release = fixture().release;
  if (!release) notFound("HTTP 404: Not Found (https://api.github.com/" + sub + ")");
  out(release);
} else if (cmd === "api" && API_PULL.test(sub ?? "")) {
  // 行内评论、review 列表：没有。
} else if (cmd === "api" && sub === "graphql" && /pullRequest\(number: \d+\)/.test(field("query") ?? "") && field("owner") !== undefined && field("name") !== undefined) {
  const query = field("query");
  const full = query.includes("allReviews:");
  const tail = `/${field("owner")}/${field("name")}/pull/`.toLowerCase();
  const prs = Object.entries(fixture().prs);
  if (!prs.some(([url]) => url.includes(tail))) {
    out({ data: { rateLimit: { cost: 1, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" }, repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: `Could not resolve to a Repository with the name '${field("owner")}/${field("name")}'.` }] });
    process.exit(1);
  }
  const repository = {};
  const errors = [];
  for (const m of query.matchAll(/p(\d+): pullRequest\(number: (\d+)\)/g)) {
    const pr = prs.find(([url]) => url.endsWith(`${tail}${m[2]}`))?.[1];
    repository[`p${m[1]}`] = pr ? prNode(pr, full) : null;
    if (!pr) errors.push({ type: "NOT_FOUND", path: ["repository", `p${m[1]}`], message: `Could not resolve to a PullRequest with the number of ${m[2]}.` });
  }
  out({ data: { rateLimit: { cost: 1, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" }, repository }, ...(errors.length > 0 && { errors }) });
  if (errors.length > 0) process.exit(1);
} else if (cmd === "api" && API_PULL_PAGE.test(sub ?? "") && args.includes("-i")) {
  // 行内评论、review 列表：没有。
  http([]);
} else if (cmd === "api" && API_RUNS.test(sub ?? "") && args.includes("-i")) {
  http({ total_count: 0, workflow_runs: [] });
} else if (cmd === "api" && sub === "graphql" && /^\s*query/.test(field("query") ?? "") && field("number") !== undefined) {
  out({ data: { repository: { pullRequest: { reviewThreads: { nodes: fixture().threads[field("number")] ?? [] } } } } });
} else if (cmd === "api" && sub === "graphql" && /^\s*mutation/.test(field("query") ?? "") && field("id") !== undefined) {
  out({ data: { resolveReviewThread: { thread: { id: field("id"), isResolved: true } } } });
} else if (cmd === "api" && API_REPLY.test(sub ?? "") && field("body") !== undefined) {
  out({ html_url: "https://github.com/acme/app/pull/0#fake-reply" });
} else if (cmd === "api" && API_PR_FILES.test(sub ?? "")) {
  // review 效果（工作流 G）：PR 合并后取改了哪些文件。
  for (const f of fixture().files[API_PR_FILES.exec(sub)[1]] ?? []) process.stdout.write(`${f}\n`);
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
