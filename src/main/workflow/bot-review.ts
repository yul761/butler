import type { ReviewBot } from "../../shared/workflow";

/**
 * 向 Copilot / Codex 请求一次 PR review（BTL-273）。
 *
 * Copilot 依次试：
 * 1. `POST /repos/{o}/{r}/pulls/{n}/copilot-code-review`（2026-10 起的正式接口；409 = 已经有一次在排队，当作请过了）；
 * 2. `POST .../requested_reviewers`，reviewers 填 copilot-pull-request-reviewer[bot]（老接口，GHE 上也常见）；
 * 3. `gh pr edit N --add-reviewer @copilot`（gh 2.80 以后认 @copilot）。
 * Codex：在 PR 上评论 `@codex review`。
 * 超时、gh 起不来、每一种都失败：算没请到（不当成功），带回最后一个错误。
 */

export interface GhRun {
  (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string | null; stderr: string; spawnError?: string | null; timedOut?: boolean }>;
}

export interface BotReviewTarget {
  cwd: string;
  /** owner/repo，或 GHE 的 host/owner/repo。 */
  slug: string;
  number: number;
  bot: ReviewBot;
}

/** off：对外动作「请 bot review」的开关关着，没请（交给 session 自己请）。 */
export type BotReviewResult = { ok: true; via: "api" | "api_pending" | "requested_reviewers" | "pr_edit" | "comment" } | { ok: false; error: string; off?: true };

const COPILOT_LOGIN = "copilot-pull-request-reviewer[bot]";

/** slug 拆成 gh api 的路径和主机（GHE 的 host/owner/repo 要 --hostname）。 */
function apiParts(slug: string): { path: string; host: string[] } {
  const p = slug.split("/");
  return p.length === 3 ? { path: `${p[1]}/${p[2]}`, host: ["--hostname", p[0]] } : { path: slug, host: [] };
}

const firstLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "")?.slice(0, 200) ?? "";

function errorOf(r: { stderr: string; spawnError?: string | null; timedOut?: boolean }): string {
  if (r.timedOut) return "timed out";
  return firstLine(r.stderr) || (r.spawnError ? `gh failed (${r.spawnError})` : "gh failed");
}

/** 给 session 自己跑的命令（手动档，或 Shipherd 请失败时）。 */
export function botReviewCommands(slug: string, number: number, bot: ReviewBot): string[] {
  const { path, host } = apiParts(slug);
  const h = host.length ? ` ${host.join(" ")}` : "";
  if (bot === "codex") return [`gh pr comment ${number} -R ${slug} --body "@codex review"`];
  return [`gh api${h} -X POST repos/${path}/pulls/${number}/copilot-code-review`, `gh pr edit ${number} -R ${slug} --add-reviewer @copilot`];
}

export async function requestBotReview(run: GhRun, t: BotReviewTarget): Promise<BotReviewResult> {
  const { path, host } = apiParts(t.slug);
  if (t.bot === "codex") {
    const r = await run(t.cwd, ["pr", "comment", String(t.number), "-R", t.slug, "--body", "@codex review"]);
    return r.stdout !== null ? { ok: true, via: "comment" } : { ok: false, error: errorOf(r) };
  }
  const api = await run(t.cwd, ["api", ...host, "-X", "POST", `repos/${path}/pulls/${t.number}/copilot-code-review`]);
  if (api.stdout !== null) return { ok: true, via: "api" };
  if (!api.timedOut && /HTTP 409/.test(api.stderr)) return { ok: true, via: "api_pending" };
  const req = await run(t.cwd, ["api", ...host, "-X", "POST", `repos/${path}/pulls/${t.number}/requested_reviewers`, "-f", `reviewers[]=${COPILOT_LOGIN}`]);
  if (req.stdout !== null) return { ok: true, via: "requested_reviewers" };
  const edit = await run(t.cwd, ["pr", "edit", String(t.number), "-R", t.slug, "--add-reviewer", "@copilot"]);
  if (edit.stdout !== null) return { ok: true, via: "pr_edit" };
  // 第一个接口的错误最说明问题（422 没有额度、没开 Copilot review）；它没说什么才用后面的。
  return { ok: false, error: errorOf(api) || errorOf(edit) };
}

/**
 * 经对外动作开关和审计请 bot review（契约 4.8）：开关 pr_review_request 关着不调 gh，返回 off（审计记 skipped）；
 * 请了就记 done，没请成记 failed。
 */
export async function requestBotReviewGuarded(
  external: { attempt<T>(kind: "pr_review_request", detail: { scope: { repoSlug: string; ticketKey: string | null }; target: string | null; summary: string }, run: () => Promise<T>): Promise<{ ran: false } | { ran: true; value: T }> },
  t: BotReviewTarget & { ticketKey: string | null; url: string | null },
  request: () => Promise<BotReviewResult>,
): Promise<BotReviewResult> {
  let result: BotReviewResult | null = null;
  try {
    const r = await external.attempt("pr_review_request", { scope: { repoSlug: t.slug, ticketKey: t.ticketKey }, target: t.url, summary: `ask ${t.bot} to review PR #${t.number}` }, async () => {
      result = await request();
      // 没请成要记成 failed：抛出去让 attempt 记，下面再接住。
      if (!result.ok) throw new Error(result.error);
      return result;
    });
    if (!r.ran) return { ok: false, off: true, error: "external action pr_review_request is off" };
    return r.value;
  } catch (e) {
    return result ?? { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

/**
 * 这几次 review 一共留了几条行内评论（`--paginate --jq length` 每页打印一个数，加起来）。
 * 有一次没拉到（失败、超时、输出不是数字）就是 null：不能当成 0 条，不然处理意见这一步会被当成做完。
 */
export async function reviewCommentCount(run: GhRun, t: Omit<BotReviewTarget, "bot">, reviewIds: string[]): Promise<number | null> {
  const { path, host } = apiParts(t.slug);
  let total = 0;
  for (const id of reviewIds) {
    const r = await run(t.cwd, ["api", ...host, `repos/${path}/pulls/${t.number}/reviews/${id}/comments`, "--paginate", "--jq", "length"]);
    if (r.stdout === null || r.timedOut) return null;
    const nums = r.stdout.split(/\s+/).filter((x) => x !== "");
    if (nums.length === 0 || !nums.every((x) => /^\d+$/.test(x))) return null;
    total += nums.reduce((a, x) => a + Number(x), 0);
  }
  return total;
}
