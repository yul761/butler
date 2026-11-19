// 要哪些证据、交上来的证据够不够（设计 §3.3、§3.4 第 3 条）。纯函数。
import type { ProfileProject, RepoProfile } from "../../shared/baselines";
import { normalizePath } from "../../shared/glob";
import type { ResolvedPrPolicy } from "../../shared/pr-policy";
import { isVerifiedBad, isVerifiedOk, REQUIRABLE_CATEGORIES, type EvidenceGap, type EvidenceItem, type RequirableCategory } from "../../shared/prereview";

const trimDir = (d: string): string => normalizePath(d).replace(/^\.\/?/, "").replace(/\/+$/, "");

/** 每个改动文件归到前缀最长的那个项目（dir 为空 / "." 的是仓库根）。 */
export function projectsFor(profile: RepoProfile | null, files: readonly string[]): ProfileProject[] {
  if (!profile || profile.projects.length === 0) return [];
  const hit = new Set<ProfileProject>();
  for (const raw of files) {
    const f = normalizePath(raw);
    let best: ProfileProject | null = null;
    let bestLen = -1;
    for (const p of profile.projects) {
      const d = trimDir(p.dir);
      if (d !== "" && f !== d && !f.startsWith(`${d}/`)) continue;
      if (d.length > bestLen) {
        best = p;
        bestLen = d.length;
      }
    }
    if (best) hit.add(best);
  }
  return [...hit];
}

/** 档案里这类有命令吗（auto 模式按这个定要不要）。 */
function hasCommand(p: ProfileProject, c: RequirableCategory): boolean {
  switch (c) {
    case "test":
      return Boolean(p.testAll || p.testOne);
    case "lint":
      return Boolean(p.lint);
    case "typecheck":
      return Boolean(p.typecheck);
    case "build":
      return Boolean(p.build);
  }
}

/**
 * 这次改动要哪些检查类证据（验收条件另外总是要）。auto 按档案：改动涉及的项目有这类命令就要；
 * 没有档案（或改动不在任何项目里）时 auto 只要 test。on 总是要，off 不要。
 */
export function requiredEvidence(profile: RepoProfile | null, files: readonly string[], policy: ResolvedPrPolicy["evidence"]): RequirableCategory[] {
  const projects = projectsFor(profile, files);
  return REQUIRABLE_CATEGORIES.filter((c) => {
    const mode = policy.require[c];
    if (mode === "on") return true;
    if (mode === "off") return false;
    if (projects.length === 0) return c === "test";
    return projects.some((p) => hasCommand(p, c));
  });
}

/** 一条 notRun 是不是在说这一类（交了 category 就按它，没交就看名字里有没有类别词）。 */
function notRunFor(item: EvidenceItem, c: RequirableCategory): boolean {
  if (item.kind !== "not_run") return false;
  if (item.category && item.category !== "other") return item.category === c;
  const name = item.name.toLowerCase();
  return c === "typecheck" ? /type ?check|tsc|mypy|pyright/.test(name) : name.includes(c);
}

/**
 * 对照要的证据，列出缺口：一类有一条 rerun_pass / consistent 的 check 就算有效；
 * 有 rerun_fail / mismatch 的算不实（bad）；只写了没跑的原因算已说明（explained）；其余算缺（missing，含核实不了的）。
 * 验收条件：至少一条。
 */
export function evidenceStatus(items: readonly EvidenceItem[], required: readonly RequirableCategory[]): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  for (const c of required) {
    const checks = items.filter((i) => i.kind === "check" && i.category === c);
    if (checks.some((i) => isVerifiedOk(i.verified))) continue;
    const bad = checks.find((i) => isVerifiedBad(i.verified));
    if (bad) {
      gaps.push({ category: c, state: "bad", detail: bad.verifyDetail?.trim() || bad.name });
      continue;
    }
    const explained = items.find((i) => notRunFor(i, c));
    if (explained) {
      gaps.push({ category: c, state: "explained", detail: explained.summary.trim() || explained.name });
      continue;
    }
    const unverifiable = checks.find((i) => i.verified === "unverifiable" || i.verified === "pending");
    gaps.push({ category: c, state: "missing", detail: unverifiable ? unverifiable.verifyDetail?.trim() || "unverifiable" : "" });
  }
  if (!items.some((i) => i.kind === "acceptance")) gaps.push({ category: "acceptance", state: "missing", detail: "" });
  return gaps;
}

/** 有没有一条核实过的测试证据（低风险的必要条件）。 */
export const hasVerifiedTest = (items: readonly EvidenceItem[]): boolean => items.some((i) => i.kind === "check" && i.category === "test" && isVerifiedOk(i.verified));
