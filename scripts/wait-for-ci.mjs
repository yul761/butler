// 发版前等 CI（BTL-262）：release.yml 的 ci-gate job 用它。tag 指向的 commit 在 main 上的 CI（ci.yml 的 push run）
// 全绿才放行；红了、取消了、一直没出现，都不建 release。
// 发版流程是先推版本提交到 main、再推 tag，CI 和 Release 同时开始跑，所以这里要等 CI 跑完，而不是一看没有结果就失败。
//
// 用法（在 Actions 里）：GH_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/wait-for-ci.mjs <tag 或 commit>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** CI run 还没出现时最多等这么久（推 main 和推 tag 之间可能隔几分钟）。 */
export const APPEAR_TIMEOUT_MS = 20 * 60_000;
/** 总共最多等这么久（CI 的 test 和 package 两个 job 各最多 45 分钟）。 */
export const MAX_WAIT_MS = 150 * 60_000;
export const POLL_MS = 30_000;
/**
 * tag 指向的 commit 不在 main 上（比如在 release 分支上打的 tag）时，等这么久就报错，不等满 APPEAR_TIMEOUT_MS：
 * main 上的 CI 永远不会跑它。留一点时间，是给 `git push origin main v1.2.3` 这种一起推、main 稍后才更新的情况。
 */
export const NOT_ON_MAIN_GRACE_MS = 2 * 60_000;

/**
 * @typedef {{ id: number, run_number: number, run_attempt?: number, head_sha: string, head_branch: string | null, event: string,
 *   status: string, conclusion: string | null, html_url: string, created_at: string }} WorkflowRun
 */

/**
 * 看这些 CI run，决定放行、失败还是接着等。
 * 只认 main 上 push 触发的、head_sha 就是这个 commit 的 run；有好几个时看最新的那个（重跑会更新同一个 run 的结论）。
 * onMain：这个 commit 在不在 main 的历史里（null = 没查到，按在处理）。
 * @param {{ sha: string, runs: WorkflowRun[], waitedMs: number, onMain?: boolean | null, appearTimeoutMs?: number, maxWaitMs?: number, notOnMainGraceMs?: number }} input
 * @returns {{ state: "pass" | "fail" | "wait", message: string }}
 */
export function ciVerdict({ sha, runs, waitedMs, onMain = null, appearTimeoutMs = APPEAR_TIMEOUT_MS, maxWaitMs = MAX_WAIT_MS, notOnMainGraceMs = NOT_ON_MAIN_GRACE_MS }) {
  const mine = runs
    .filter((r) => r.head_sha === sha && r.event === "push" && r.head_branch === "main")
    .sort((a, b) => b.run_number - a.run_number);
  const run = mine[0];
  if (!run) {
    if (onMain === false) {
      if (waitedMs < notOnMainGraceMs) return { state: "wait", message: `${sha} is not on main (yet)` };
      return {
        state: "fail",
        message: `${sha} is not on main, so CI on main never runs on it and no release is drafted. Tag a commit that is on main (push the version commit to main first). To release this commit anyway, run Release by hand on the tag with skip_ci_check.`,
      };
    }
    if (waitedMs < appearTimeoutMs) return { state: "wait", message: `no CI run on main for ${sha} yet` };
    return {
      state: "fail",
      message: `no CI run on main for ${sha} after ${Math.round(waitedMs / 60_000)} minutes. Push the version commit to main before the tag, so CI runs on it. To release anyway, run Release by hand on the tag with skip_ci_check.`,
    };
  }
  if (run.status !== "completed") {
    if (waitedMs < maxWaitMs) return { state: "wait", message: `CI run ${run.html_url} is ${run.status}` };
    return { state: "fail", message: `CI run ${run.html_url} is still ${run.status} after ${Math.round(waitedMs / 60_000)} minutes` };
  }
  if (run.conclusion === "success") return { state: "pass", message: `CI run ${run.html_url} passed` };
  return {
    state: "fail",
    message: `CI run ${run.html_url} finished with "${run.conclusion}", so no release is drafted. Fix main (or re-run CI if the failure was flaky), then re-run this workflow's failed jobs.`,
  };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (e) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

/** 一次 API 失败（限流、网络、5xx）不该让发版失败：重试几次再放弃。 */
async function retrying(what, fn, attempts = 5, delayMs = 10_000) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= attempts) throw new Error(`${what} failed ${attempts} times: ${firstLine(e)}`, { cause: e });
      console.log(`${what} failed (${firstLine(e)}); retrying`);
      await sleep(delayMs);
    }
  }
}

/** sha 在不在 main 的历史里：compare main...sha 是 identical（就是 main）或 behind（main 的祖先）。查不到返回 null。 */
function isOnMain(repo, sha) {
  try {
    const status = gh(["api", `repos/${repo}/compare/main...${sha}`, "--jq", ".status"]).trim();
    return status === "identical" || status === "behind";
  } catch (e) {
    console.log(`could not compare ${sha} with main (${firstLine(e)})`);
    return null;
  }
}

async function main() {
  const ref = process.argv[2];
  const repo = process.env.GITHUB_REPOSITORY;
  if (!ref || !repo) throw new Error("usage: GITHUB_REPOSITORY=owner/repo node scripts/wait-for-ci.mjs <tag or commit>");
  // 注解 tag 指向 tag 对象，commits 接口会把它解到 commit 上。
  const sha = await retrying(`resolving ${ref}`, () => gh(["api", `repos/${repo}/commits/${encodeURIComponent(ref)}`, "--jq", ".sha"]).trim());
  console.log(`waiting for CI on ${sha} (${ref})`);
  const started = Date.now();
  let last = "";
  for (;;) {
    let runs = [];
    try {
      runs = JSON.parse(gh(["api", `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=50`, "--jq", ".workflow_runs"]));
    } catch (e) {
      // 一次查询失败（限流、网络）：下次再查，总时间照算。
      console.log(`could not list CI runs (${firstLine(e)}); retrying`);
    }
    // 还没有 CI run 时才看它在不在 main 上（有 main 的 push run 就说明在）。
    const onMain = runs.some((r) => r.head_sha === sha) ? true : isOnMain(repo, sha);
    const v = ciVerdict({ sha, runs, waitedMs: Date.now() - started, onMain });
    if (v.message !== last) console.log(v.message);
    last = v.message;
    if (v.state === "pass") return;
    if (v.state === "fail") {
      console.log(`::error::${v.message}`);
      process.exit(1);
    }
    await sleep(POLL_MS);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.log(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
