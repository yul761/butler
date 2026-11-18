// 仓库档案写进 session guide 的样子（设计 §5.2）：每个仓库一段，有字数上限，超了从后面删（先删 CI，再删目录约定，再删次要项目），留一个「…」。
import type { Lang } from "../../shared/i18n";
import type { ProfileProject, RepoBaseline } from "../../shared/baselines";

const L = {
  zh: {
    head: (slug: string, date: string) => `仓库 ${slug} 的现状（${date} 扫描，仓库自己用的命令）：`,
    stale: "这次扫描之后配置文件改过，命令可能变了，用之前先核对一下。",
    inferred: "（推断）",
    root: "根目录",
    fields: { install: "装依赖", build: "构建", testAll: "全部测试", testOne: "单个测试", fastest: "最快的检查", lint: "lint", typecheck: "类型检查" },
    dirs: "目录约定",
    ci: "CI 里跑的",
    pitfalls: "踩过的坑",
  },
  en: {
    head: (slug: string, date: string) => `Repo ${slug} (scanned ${date}; the repo's own commands):`,
    stale: "Config files changed since this scan; check the commands before relying on them.",
    inferred: " (inferred)",
    root: "root",
    fields: { install: "install", build: "build", testAll: "all tests", testOne: "one test", fastest: "fastest check", lint: "lint", typecheck: "type check" },
    dirs: "layout",
    ci: "CI runs",
    pitfalls: "known pitfalls",
  },
} as const;

const FIELDS = ["install", "build", "testAll", "testOne", "fastest", "lint", "typecheck"] as const;
export const ELLIPSIS = "…";

function projectBlock(lang: Lang, p: ProfileProject, single: boolean): string[] {
  const s = L[lang];
  const lines: string[] = [];
  for (const f of FIELDS) {
    const v = p[f];
    if (!v) continue;
    lines.push(`${single ? "- " : "  - "}${s.fields[f]}: \`${v}\`${p.inferred.includes(f) ? s.inferred : ""}`);
  }
  if (!lines.length) return [];
  if (single && !p.dir) return lines;
  return [`- ${p.dir || s.root}${p.langs.length ? ` (${p.langs.join(", ")})` : ""}:`, ...(single ? lines.map((l) => `  ${l}`) : lines)];
}

export interface ProfileTextOptions {
  lang: Lang;
  maxChars: number;
  stale: boolean;
  /** 列出踩过的坑（guide 里已经有规矩那一段时不重复）。 */
  pitfalls: boolean;
}

/** 一个仓库的档案文字；什么命令都没有时返回空串。 */
export function profileText(b: Pick<RepoBaseline, "slug" | "scannedAt" | "profile">, o: ProfileTextOptions): string {
  const s = L[o.lang];
  const projects = b.profile.projects.filter((p) => FIELDS.some((f) => p[f]));
  if (!projects.length && !b.profile.ci.length) return "";
  // 主项目：根目录有命令就是根目录，否则第一个。
  const ordered = [...projects].sort((a, c) => (a.dir === "" ? -1 : c.dir === "" ? 1 : a.dir < c.dir ? -1 : 1));
  const single = ordered.length === 1;
  const blocks = ordered.map((p) => projectBlock(o.lang, p, single)).filter((x) => x.length);
  const head = [s.head(b.slug, new Date(b.scannedAt).toISOString().slice(0, 10)), ...(o.stale ? [s.stale] : [])];
  const pit = o.pitfalls && b.profile.pitfalls.length ? [`- ${s.pitfalls}:`, ...b.profile.pitfalls.slice(0, 5).map((t) => `  - ${t.replace(/\s+/g, " ").slice(0, 200)}`)] : [];
  let dirs = b.profile.dirs.length ? [`- ${s.dirs}: ${b.profile.dirs.join(", ")}`] : [];
  let ci = b.profile.ci.length ? [`- ${s.ci}:`, ...b.profile.ci.map((c) => `  - \`${c.command}\`${c.dir ? ` (${c.dir})` : ""}`)] : [];
  let primary = blocks[0] ?? [];
  let secondary = blocks.slice(1);
  const render = () => [...head, ...primary, ...secondary.flat(), ...pit, ...dirs, ...ci].join("\n");
  let text = render();
  let cut = false;
  // 先一行一行删 CI，再删目录约定，再从后往前删次要项目。
  while (text.length > o.maxChars && ci.length) {
    ci = ci.length > 2 ? ci.slice(0, -1) : [];
    cut = true;
    text = render();
  }
  if (text.length > o.maxChars && dirs.length) {
    dirs = [];
    cut = true;
    text = render();
  }
  while (text.length > o.maxChars && secondary.length) {
    secondary = secondary.slice(0, -1);
    cut = true;
    text = render();
  }
  if (text.length > o.maxChars) {
    // 主项目也放不下：一行一行删。
    while (primary.length > 1 && text.length > o.maxChars) {
      primary = primary.slice(0, -1);
      text = render();
    }
    cut = true;
  }
  if (cut) text = `${text}\n${ELLIPSIS}`;
  if (text.length > o.maxChars) text = `${text.slice(0, Math.max(0, o.maxChars - 1))}${ELLIPSIS}`;
  return text;
}

/** 几个仓库的档案拼起来，总长不超过 total（后面的仓库整段删掉，留「…」）。 */
export function joinProfiles(texts: string[], total: number): string {
  const out: string[] = [];
  let len = 0;
  for (const t of texts.filter(Boolean)) {
    if (len + t.length + 2 > total) {
      out.push(ELLIPSIS);
      break;
    }
    out.push(t);
    len += t.length + 2;
  }
  return out.join("\n\n");
}
