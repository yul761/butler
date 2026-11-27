import { mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRIP_SUFFIX, dripName, type DripLesson, type DripManifest, type DripRoot } from "../../shared/lesson-drip";
import type { Lang } from "../../shared/i18n";
import type { LessonsRepo } from "../db/lessons-repo";
import type { RepoIdentity } from "./repo-identity";
import type { GuidePlan } from "./select";

/**
 * 编辑时补送（BTL-274）的清单：这个 session 能改到的目录按仓库 slug 分好（同一个 ticket 的几个仓库各算各的，
 * 相对路径一样也不会串），加上说明里没写全文的规矩和它们适用的仓库。
 */
export function dripRoots(identity: RepoIdentity, dirs: readonly string[], real: (p: string) => string | null = safeRealpath): DripRoot[] {
  const by = new Map<string, Set<string>>();
  for (const dir of dirs) {
    if (!dir) continue;
    const slug = identity.slugOf(dir);
    if (!slug) continue;
    const set = by.get(slug) ?? new Set<string>();
    set.add(dir);
    const r = real(dir);
    if (r) set.add(r);
    by.set(slug, set);
  }
  return [...by].map(([slug, set]) => ({ slug, dirs: [...set] }));
}

const safeRealpath = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

export function dripManifest(repo: LessonsRepo, plan: Pick<GuidePlan, "rest">, roots: DripRoot[], lang: Lang): DripManifest | null {
  if (plan.rest.length === 0 || roots.length === 0) return null;
  const slugs = roots.map((r) => r.slug);
  const productSlugs = new Map<number, string[]>();
  for (const slug of slugs) for (const p of repo.productsOf(slug)) productSlugs.set(p.id, [...(productSlugs.get(p.id) ?? []), slug]);
  const lessons: DripLesson[] = [];
  for (const l of plan.rest) {
    const to = l.scope.kind === "repo" ? (slugs.includes(l.scope.slug) ? [l.scope.slug] : []) : (productSlugs.get(l.scope.productId) ?? []);
    if (to.length === 0) continue;
    lessons.push({ id: l.id, label: l.label, text: l.text, why: l.why, globs: l.globs, lang: l.lang, slugs: to });
  }
  return lessons.length ? { v: 1, lang: lang === "en" ? "en" : "zh", roots, lessons } : null;
}

/**
 * 写清单（先写临时文件再改名，hook 不会读到半份）。没有要补送的就删掉旧清单。已送记录（.sent）不动：
 * 恢复的 session 上下文里还有以前送过的；clear、compact 和全新开始时由 SessionStart 的 hook 清。
 */
export function writeDripManifest(dir: string, sessionId: string, m: DripManifest | null): void {
  const base = join(dir, dripName(sessionId));
  if (!m) {
    try {
      unlinkSync(`${base}${DRIP_SUFFIX}`);
    } catch {
      /* 本来就没有 */
    }
    return;
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${base}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(m));
  renameSync(tmp, `${base}${DRIP_SUFFIX}`);
}

/**
 * 开 session 时准备补送：hook 装着、有要补送的才写清单，否则删掉旧的。返回补送是不是真的会发生（清单写到了磁盘上）：
 * 说明里写不写「编辑时补送」就看它，清单没写出来（没装 hook、没有要补送的、写失败）就不写，免得是假话。
 */
export function prepareSessionDrip(d: {
  hookInstalled: boolean; dir: string; sessionId: string; manifest: () => DripManifest | null; log: (msg: string, e: unknown) => void;
}): boolean {
  try {
    const m = d.hookInstalled ? d.manifest() : null;
    writeDripManifest(d.dir, d.sessionId, m);
    return m !== null;
  } catch (e) {
    d.log("lesson drip manifest not written", e);
    return false;
  }
}

const DRIP_MAX_AGE_MS = 30 * 24 * 3600_000;

/** 启动时清掉 30 天没动过的清单和已送记录；返回删了几个。 */
export function pruneDrip(dir: string, now: number): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    try {
      const f = join(dir, name);
      if (now - statSync(f).mtimeMs <= DRIP_MAX_AGE_MS) continue;
      unlinkSync(f);
      n++;
    } catch {
      /* 单个文件出错不影响其他的 */
    }
  }
  return n;
}
