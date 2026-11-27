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

export type BotReviewResult = { ok: true; via: "api" | "api_pending" | "requested_reviewers" | "pr_edit" | "comment" } | { ok: false; error: string };

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
