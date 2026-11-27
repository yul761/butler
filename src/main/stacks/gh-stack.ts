import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoEnv, runGhDetail } from "../tickets/gh";

/**
 * 栈用到的 gh 写操作（设计第 4、5、9 节）。失败抛错（ExternalActions.attempt 记 failed），成功返回解析结果。
 * 正文一律走 --body-file：Windows 的命令行有长度上限。
 */

export const GH_TIMEOUT_MS = 30_000;

export class GhStackError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

async function gh(cwd: string, slug: string | null, args: string[]): Promise<string> {
  const r = await runGhDetail(cwd, args, GH_TIMEOUT_MS, 8 * 1024 * 1024, repoEnv(slug));
  if (r.stdout === null) throw new GhStackError(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim() || "gh is not available"}`, r.stderr);
  return r.stdout;
}

async function withBody<T>(body: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "shipherd-stack-body-"));
  const file = join(dir, "body.md");
  writeFileSync(file, body);
  try {
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** gh pr create / issue create 打印新建的链接（最后一行）。 */
export function parseCreatedUrl(out: string): { number: number; url: string } | null {
  const lines = out.trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    const m = /^(https?:\/\/\S+\/(?:pull|issues)\/(\d+))\s*$/.exec(l.trim());
    if (m) return { number: Number(m[2]), url: m[1]! };
  }
  return null;
}

export interface CreatePr {
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
}

export async function prCreate(cwd: string, slug: string | null, p: CreatePr): Promise<{ number: number; url: string }> {
  return withBody(p.body, async (file) => {
    const args = ["pr", "create", "--base", p.base, "--head", p.head, "--title", p.title, "--body-file", file];
    if (p.draft) args.push("--draft");
    for (const l of p.labels) args.push("--label", l);
    const out = await gh(cwd, slug, args);
    const r = parseCreatedUrl(out);
    if (!r) throw new GhStackError(`gh pr create: unexpected output: ${out.trim().slice(0, 200)}`, "");
    return r;
  });
}

export async function prEditBase(cwd: string, slug: string | null, n: number, base: string): Promise<void> {
  await gh(cwd, slug, ["pr", "edit", String(n), "--base", base]);
}

export async function prEditTitle(cwd: string, slug: string | null, n: number, title: string): Promise<void> {
  await gh(cwd, slug, ["pr", "edit", String(n), "--title", title]);
}

export async function prEditBody(cwd: string, slug: string | null, n: number, body: string): Promise<void> {
  await withBody(body, (file) => gh(cwd, slug, ["pr", "edit", String(n), "--body-file", file]));
}

export async function prLabel(cwd: string, slug: string | null, n: number, label: string, add: boolean): Promise<void> {
  await gh(cwd, slug, ["pr", "edit", String(n), add ? "--add-label" : "--remove-label", label]);
}

export async function prReady(cwd: string, slug: string | null, n: number): Promise<void> {
  await gh(cwd, slug, ["pr", "ready", String(n)]);
}

export async function prClose(cwd: string, slug: string | null, n: number, comment: string): Promise<void> {
  await gh(cwd, slug, ["pr", "close", String(n), "--comment", comment]);
}

/** label 不存在就建；已经存在不算错。 */
export async function ensureLabel(cwd: string, slug: string | null, name: string, description: string): Promise<void> {
  const r = await runGhDetail(cwd, ["label", "create", name, "--description", description, "--color", "BFD4F2"], GH_TIMEOUT_MS, 1024 * 1024, repoEnv(slug));
  if (r.stdout === null && !/already exists/i.test(r.stderr)) throw new GhStackError(`gh label create failed: ${r.stderr.trim()}`, r.stderr);
}

export interface PrSnapshot {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  title: string;
  body: string;
  base: string;
  head: string;
  headSha: string | null;
  labels: string[];
  /** 从 fork 开过来的（head 同名也不是这个仓库的分支）。 */
  crossRepo?: boolean;
  /** head 分支所在的仓库（owner/name，小写）；gh 没给时 null。fork 工作流里按它认是不是栈的 remote 上的分支（BTL-278）。 */
  headRepo?: string | null;
}

function snapshot(v: unknown): PrSnapshot | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.number !== "number" || typeof r.url !== "string") return null;
  const state = r.state === "MERGED" || r.state === "CLOSED" ? r.state : "OPEN";
  const labels = Array.isArray(r.labels) ? r.labels.map((l) => (l as { name?: unknown }).name).filter((x): x is string => typeof x === "string") : [];
  return {
    number: r.number, url: r.url, state, isDraft: r.isDraft === true, title: typeof r.title === "string" ? r.title : "",
    body: typeof r.body === "string" ? r.body : "", base: typeof r.baseRefName === "string" ? r.baseRefName : "",
    head: typeof r.headRefName === "string" ? r.headRefName : "", headSha: typeof r.headRefOid === "string" ? r.headRefOid : null, labels,
    crossRepo: r.isCrossRepository === true, headRepo: headRepoOf(r),
  };
}

function headRepoOf(r: Record<string, unknown>): string | null {
  const owner = (r.headRepositoryOwner as { login?: unknown } | null | undefined)?.login;
  const name = (r.headRepository as { name?: unknown } | null | undefined)?.name;
  return typeof owner === "string" && typeof name === "string" && owner && name ? `${owner}/${name}`.toLowerCase() : null;
}

const FIELDS = "number,url,state,isDraft,title,body,baseRefName,headRefName,headRefOid,labels,isCrossRepository,headRepository,headRepositoryOwner";

export async function prView(cwd: string, slug: string | null, n: number): Promise<PrSnapshot | null> {
  try {
    return snapshot(JSON.parse(await gh(cwd, slug, ["pr", "view", String(n), "--json", FIELDS])));
  } catch {
    return null;
  }
}

/** openPrs 一次最多读这么多条；读满了说明可能还有，要按分支再查（BTL-278）。 */
export const OPEN_PR_LIMIT = 200;

/** 仓库里开着的 PR（自动检测栈用）。失败返回 null。 */
export async function openPrs(cwd: string, slug: string | null): Promise<PrSnapshot[] | null> {
  try {
    const j = JSON.parse(await gh(cwd, slug, ["pr", "list", "--state", "open", "--limit", String(OPEN_PR_LIMIT), "--json", FIELDS])) as unknown;
    return Array.isArray(j) ? j.map(snapshot).filter((x): x is PrSnapshot => x !== null) : null;
  } catch {
    return null;
  }
}

/** 这几个分支上开着的 PR（openPrs 读满一页时逐个查）。有一个查不到就返回 null。 */
export async function openPrsForHeads(cwd: string, slug: string | null, heads: string[]): Promise<PrSnapshot[] | null> {
  const out: PrSnapshot[] = [];
  for (const head of heads) {
    try {
      const j = JSON.parse(await gh(cwd, slug, ["pr", "list", "--state", "open", "--head", head, "--json", FIELDS])) as unknown;
      if (!Array.isArray(j)) return null;
      out.push(...j.map(snapshot).filter((x): x is PrSnapshot => x !== null));
    } catch {
      return null;
    }
  }
  return out;
}

export async function issueCreate(cwd: string, slug: string | null, title: string, body: string): Promise<{ number: number; url: string }> {
  return withBody(body, async (file) => {
    const out = await gh(cwd, slug, ["issue", "create", "--title", title, "--body-file", file]);
    const r = parseCreatedUrl(out);
    if (!r) throw new GhStackError(`gh issue create: unexpected output: ${out.trim().slice(0, 200)}`, "");
    return r;
  });
}

export async function issueEdit(cwd: string, slug: string | null, n: number, title: string, body: string): Promise<void> {
  await withBody(body, (file) => gh(cwd, slug, ["issue", "edit", String(n), "--title", title, "--body-file", file]));
}
