import { PRINCIPLE_MIN_CASES } from "./admission/model-steps";
import {
  CORE_GUIDE_MAX, GUIDE_FULL_BUDGET, GUIDE_INDEX_BUDGET, INDEX_TITLE_MAX, LESSON_DELIVERIES,
  type Lesson, type LessonDelivery, type LessonDeliveryCounts, type LessonProductSuggestion, type LessonProductView, type LessonScope, type SessionLesson,
} from "../../shared/lessons";
import { lessonScoped } from "../../shared/lesson-scope";
import type { LessonsRepo } from "../db/lessons-repo";
import type { RepoIdentity } from "./repo-identity";

/** 出现次数降序，再最后出现时间降序，再 id 升序。 */
const byRank = (a: Lesson, b: Lesson): number => b.hits - a.hits || b.lastSeenAt - a.lastSeenAt || a.id - b.id;

/** 这些 slug 的仓库规矩和所属产品规矩（已确认，按 id 去重），带上 label，已排好序。 */
function confirmedFor(repo: LessonsRepo, slugs: string[]): { lesson: Lesson; label: string }[] {
  const out: { lesson: Lesson; label: string }[] = [];
  const seen = new Set<number>();
  const push = (lesson: Lesson, label: string) => {
    if (seen.has(lesson.id) || lesson.mergedInto !== null) return;
    seen.add(lesson.id);
    out.push({ lesson, label });
  };
  const products = new Map<number, string>();
  for (const slug of slugs) {
    for (const lesson of repo.lessons({ status: ["confirmed"], scope: { kind: "repo", slug } })) push(lesson, slug);
    for (const p of repo.productsOf(slug)) products.set(p.id, p.name);
  }
  for (const [productId, name] of products) {
    for (const lesson of repo.lessons({ status: ["confirmed"], scope: { kind: "product", productId } })) push(lesson, name);
  }
  return out.sort((a, b) => byRank(a.lesson, b.lesson));
}

/** 会话说明怎么挑规矩（工作流 D 的两个设置，加上 BTL-274 的预算）。 */
export interface GuideLessonOptions {
  /** lessonsPrinciples：属于一个原则的规矩换成一行原则，规矩本身成了它的案例。没开时，全文装不下也会用原则行（BTL-274）。 */
  principles?: boolean;
  /** lessonsCoreGuide：全文最多 CORE_GUIDE_MAX 行，确认以后又被违反最多的在前；其余的照样进索引、补送。 */
  core?: boolean;
  /** 确定性检查在跑：已转成检查的规矩由检查管，不占说明的位置。检查关着时它们照常当文字送（不然就真丢了）。默认 true。 */
  checksActive?: boolean;
  /** 全文的字符预算（默认 GUIDE_FULL_BUDGET）。 */
  fullBudget?: number;
  /** 索引的字符预算（默认 GUIDE_INDEX_BUDGET）。 */
  indexBudget?: number;
}

/** 索引里的一行：标题和适用范围，全文用 lessons 工具查、编辑匹配的文件时补送。 */
export interface IndexLesson {
  id: number;
  label: string;
  title: string;
  globs: string[];
  lang: string | null;
}

/** 没写全文的规矩（补送和 lessons 工具用）：带范围和它属于哪个仓库 / 产品。 */
export interface RestLesson {
  id: number;
  label: string;
  text: string;
  why: string;
  globs: string[];
  lang: string | null;
  scope: LessonScope;
}

/** 一个 session 的规矩怎么送（BTL-274）。 */
export interface GuidePlan {
  /** 全文写进说明的行（原则行带 cases）。 */
  full: SessionLesson[];
  /** 索引行。 */
  index: IndexLesson[];
  /** 没写全文、索引也放不下的条数（说明里只写条数，叫 session 用 lessons 工具查）。 */
  indexMore: number;
  /** 所有没写全文的规矩（原则的案例也在里面），排好序：补送 hook 和旁边的全文文件用。 */
  rest: RestLesson[];
  /** 每条已确认的规矩（id）怎么送到。 */
  modes: Map<number, LessonDelivery>;
  /** 全文装不下：有规矩只能走索引、补送或原则。 */
  overBudget: boolean;
}

const EMPTY_PLAN = (): GuidePlan => ({ full: [], index: [], indexMore: 0, rest: [], modes: new Map(), overBudget: false });

/** 一行全文占的字符（和 session-guide 写出来的一样长，多算几个也无妨）。 */
const fullCost = (label: string, text: string, cases?: number): number => label.length + text.length + 8 + (cases ? 12 : 0);

/** 规矩的一行标题：第一句（到句号、分号为止），最多 INDEX_TITLE_MAX 字符。 */
export function lessonTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?)(?:[。；;！？!?]|\.(?:\s|$)|：|:\s)/.exec(flat);
  const first = (m ? m[1] : flat).trim() || flat;
  return first.length > INDEX_TITLE_MAX ? `${first.slice(0, INDEX_TITLE_MAX - 1)}…` : first;
}

const indexCost = (l: IndexLesson): number => l.label.length + l.title.length + l.globs.join(", ").length + (l.lang?.length ?? 0) + 24;

type Unit = { kind: "lesson"; lesson: Lesson; label: string } | { kind: "principle"; pid: number; text: string; label: string; members: { lesson: Lesson; label: string }[] };

/**
 * 这些仓库路径 → slug（去重、去掉解析不出的）→ 仓库的规矩和这些仓库所属产品的已确认规矩，按大小预算排成一个 session 的送法：
 * 1. 已转成检查的（检查在跑时）不占位；
 * 2. 全文按字符预算装：没限定范围的先装（处处适用，补送帮不上忙），再装限定了范围的；装不下的跳过、接着试后面短的；
 *    开了原则、或者不用原则就装不下时，属于同一个原则（至少 PRINCIPLE_MIN_CASES 条）的换成一行原则；
 * 3. 剩下的进索引（标题 + 范围），按排名装到索引预算为止；再多的只写条数；
 * 4. 剩下的全部（原则的案例也算）编辑匹配的文件时补送、lessons 工具查得到全文。
 */
export function guidePlan(repo: LessonsRepo, identity: RepoIdentity, repoPaths: string[], opts: GuideLessonOptions = {}): GuidePlan {
  const slugs = [...new Set(repoPaths.map((p) => identity.slugOf(p)).filter((s): s is string => !!s))];
  return planFor(repo, confirmedFor(repo, slugs), opts);
}

/** 只开这一个仓库时的送法（规矩页按它显示每条怎么送到）。 */
export function planForSlug(repo: LessonsRepo, slug: string, opts: GuideLessonOptions = {}): GuidePlan {
  return planFor(repo, confirmedFor(repo, [slug]), opts);
}

function planFor(repo: LessonsRepo, ranked: { lesson: Lesson; label: string }[], opts: GuideLessonOptions): GuidePlan {
  if (ranked.length === 0) return EMPTY_PLAN();
  const fullBudget = opts.fullBudget ?? GUIDE_FULL_BUDGET;
  const indexBudget = opts.indexBudget ?? GUIDE_INDEX_BUDGET;
  const checksActive = opts.checksActive ?? true;
  const modes = new Map<number, LessonDelivery>();
  let pool = ranked;
  if (checksActive) {
    for (const r of ranked) if (r.lesson.checkability === "converted") modes.set(r.lesson.id, "check");
    pool = ranked.filter((r) => r.lesson.checkability !== "converted");
  }
  if (opts.core) {
    const v = repo.violationCounts(pool.map((r) => r.lesson.id));
    pool = [...pool].sort((a, b) => (v.get(b.lesson.id) ?? 0) - (v.get(a.lesson.id) ?? 0) || byRank(a.lesson, b.lesson));
  }
  const plain: Unit[] = pool.map((r) => ({ kind: "lesson", lesson: r.lesson, label: r.label }));
  const fitsPlain = pool.reduce((n, r) => n + fullCost(r.label, r.lesson.text), 0) <= fullBudget && (!opts.core || pool.length <= CORE_GUIDE_MAX);
  const units = opts.principles || !fitsPlain ? withPrinciples(repo, pool) : plain;
  // 核心说明按违反次数排，原样装；否则没限定范围的先装。
  const order = opts.core ? units : [...units.filter((u) => !unitScoped(u)), ...units.filter(unitScoped)];
  const full: SessionLesson[] = [];
  const left: { lesson: Lesson; label: string }[] = [];
  let used = 0;
  for (const u of order) {
    const cost = u.kind === "lesson" ? fullCost(u.label, u.lesson.text) : fullCost(u.label, u.text, u.members.length);
    const room = used + cost <= fullBudget && (!opts.core || full.length < CORE_GUIDE_MAX);
    if (!room) {
      if (u.kind === "lesson") left.push({ lesson: u.lesson, label: u.label });
      else left.push(...u.members);
      continue;
    }
    used += cost;
    if (u.kind === "lesson") {
      full.push({ id: u.lesson.id, label: u.label, text: u.lesson.text });
      modes.set(u.lesson.id, "full");
    } else {
      full.push({ label: u.label, text: u.text, cases: u.members.map((m) => m.lesson.text) });
      for (const m of u.members) modes.set(m.lesson.id, "principle");
    }
  }
  // 全文的顺序回到排名（说明里排名高的在前）；原则行排在它最靠前的那条规矩的位置。
  const pos = new Map(pool.map((r, i) => [r.lesson.id, i]));
  const rowPos = (row: SessionLesson): number => (row.id !== undefined ? (pos.get(row.id) ?? 0) : Math.min(...units.filter((u) => u.kind === "principle" && u.text === row.text).flatMap((u) => (u as Extract<Unit, { kind: "principle" }>).members.map((m) => pos.get(m.lesson.id) ?? 0))));
  if (!opts.core) full.sort((a, b) => rowPos(a) - rowPos(b));
  left.sort((a, b) => (pos.get(a.lesson.id) ?? 0) - (pos.get(b.lesson.id) ?? 0));
  const index: IndexLesson[] = [];
  let indexUsed = 0;
  let indexMore = 0;
  for (const { lesson, label } of left) {
    const row: IndexLesson = { id: lesson.id, label, title: lessonTitle(lesson.text), globs: lesson.scopeGlobs, lang: lesson.scopeLang };
    const cost = indexCost(row);
    if (indexUsed + cost <= indexBudget) {
      index.push(row);
      indexUsed += cost;
      modes.set(lesson.id, lessonScoped(lesson) ? "drip" : "index");
    } else {
      indexMore++;
      modes.set(lesson.id, "drip");
    }
  }
  // 原则的案例也补送全文（它们在说明里只有原则那一行）。
  const restIds = new Set([...left.map((r) => r.lesson.id), ...pool.filter((r) => modes.get(r.lesson.id) === "principle").map((r) => r.lesson.id)]);
  const rest: RestLesson[] = pool
    .filter((r) => restIds.has(r.lesson.id))
    .map(({ lesson, label }) => ({ id: lesson.id, label, text: lesson.text, why: lesson.why, globs: lesson.scopeGlobs, lang: lesson.scopeLang, scope: lesson.scope }));
  return { full, index, indexMore, rest, modes, overBudget: left.length > 0 };
}

const unitScoped = (u: Unit): boolean => u.kind === "lesson" && lessonScoped(u.lesson);

/** 原则排在它排得最靠前的那条规矩的位置；只数这里看得到的（已确认、在这些仓库里）案例，不到 PRINCIPLE_MIN_CASES 条的原则不用，规矩各占一行。 */
function withPrinciples(repo: LessonsRepo, ranked: { lesson: Lesson; label: string }[]): Unit[] {
  const seen = new Map<number, number>();
  for (const r of ranked) if (r.lesson.principleId !== null) seen.set(r.lesson.principleId, (seen.get(r.lesson.principleId) ?? 0) + 1);
  const shown = (pid: number | null): pid is number => pid !== null && (seen.get(pid) ?? 0) >= PRINCIPLE_MIN_CASES;
  const texts = repo.principleTexts(ranked.flatMap((r) => (shown(r.lesson.principleId) ? [r.lesson.principleId] : [])));
  const out: Unit[] = [];
  const at = new Map<number, Extract<Unit, { kind: "principle" }>>();
  for (const r of ranked) {
    const pid = shown(r.lesson.principleId) ? r.lesson.principleId : null;
    const p = pid === null ? undefined : texts.get(pid);
    if (pid === null || !p) {
      out.push({ kind: "lesson", lesson: r.lesson, label: r.label });
      continue;
    }
    const prev = at.get(pid);
    if (prev) prev.members.push(r);
    else {
      const u: Extract<Unit, { kind: "principle" }> = { kind: "principle", pid, text: p.text, label: r.label, members: [r] };
      at.set(pid, u);
      out.push(u);
    }
  }
  return out;
}

/** 每种送法各几条。 */
export function deliveryCounts(plan: Pick<GuidePlan, "modes">): LessonDeliveryCounts {
  const out = Object.fromEntries(LESSON_DELIVERIES.map((d) => [d, 0])) as LessonDeliveryCounts;
  for (const m of plan.modes.values()) out[m]++;
  return out;
}

/** 同一个 ticket 或 feature 里一起出现过 ≥2 次的仓库组合（按 slug），已经全在同一个产品里的不算。 */
export function productSuggestions(groups: string[][], products: LessonProductView[]): LessonProductSuggestion[] {
  const counts = new Map<string, { slugs: string[]; together: number }>();
  for (const g of groups) {
    const slugs = [...new Set(g)].sort();
    if (slugs.length < 2) continue;
    const key = JSON.stringify(slugs);
    const c = counts.get(key);
    if (c) c.together++;
    else counts.set(key, { slugs, together: 1 });
  }
  return [...counts.values()]
    .filter((c) => c.together >= 2 && !products.some((p) => c.slugs.every((s) => p.slugs.includes(s))))
    .sort((a, b) => b.together - a.together || a.slugs.join(",").localeCompare(b.slugs.join(",")));
}

/** 送规矩出错（数据库、解析 slug）时只是这次不带规矩，不能连累整份 session 说明。 */
export function safeGuidePlan(repo: LessonsRepo, identity: RepoIdentity, repoPaths: string[], log?: (msg: string, err?: unknown) => void, opts: GuideLessonOptions = {}): GuidePlan {
  try {
    return guidePlan(repo, identity, repoPaths, opts);
  } catch (e) {
    log?.("session lessons failed, guide goes without them", e);
    return EMPTY_PLAN();
  }
}

/** 仓库档案里的「踩过的坑」（工作流 E2）：这个仓库和所属产品已确认的规矩，排好序的前 limit 条文字。 */
export function pitfallsFor(repo: LessonsRepo, slug: string, limit = 5): string[] {
  return confirmedFor(repo, [slug]).slice(0, limit).map(({ lesson }) => lesson.text);
}
