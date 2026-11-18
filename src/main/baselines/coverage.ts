// 「这条规矩是不是已经被仓库现有的检查管住了」（设计 §4.1，给 D 用）。纯函数。
import type { BaselineCategory, BaselineCheck, BaselineCoverage } from "../../shared/baselines";

interface Concept {
  key: string;
  /** 规矩文字（中英文）里的说法。 */
  words: RegExp;
  /** 检查配置里开着其中一条就算管住了（强）。 */
  facts: string[];
  /** 只有这一类检查（弱）。 */
  category?: BaselineCategory;
}

/** 内置的说法 → 规则 / 类别对照表。 */
export const CONCEPTS: Concept[] = [
  {
    key: "unused",
    words: /\bunused\b|\bdead code\b|未使用|没用到|没有用到|无用的?(?:import|导入|变量|代码)|多余的?(?:import|导入|变量)/i,
    facts: ["no-unused-vars", "@typescript-eslint/no-unused-vars", "unused-imports/no-unused-imports", "noUnusedLocals", "noUnusedParameters", "F401", "F841", "unused", "deadcode", "unparam", "Lint/UselessAssignment"],
    category: "lint",
  },
  {
    key: "any",
    words: /\bany\b[^.\n]{0,20}\btypes?\b|\btypes?\b[^.\n]{0,20}\bany\b|explicit any|implicit any|`any`|any ?类型|类型[^。\n]{0,10}any/i,
    facts: ["no-explicit-any", "@typescript-eslint/no-explicit-any", "noImplicitAny", "strict", "ANN401", "disallow_any_explicit"],
    category: "typecheck",
  },
  { key: "console", words: /console\.\w+|\bconsole (?:calls?|statements?|logs?)\b|console ?(?:语句|输出|打印)/i, facts: ["no-console", "T201"] },
  { key: "debugger", words: /\bdebugger\b|\bbreakpoint\(\)|\bpdb\b/i, facts: ["no-debugger", "T100"] },
  { key: "print", words: /\bprint\(\)?|\bprint statements?\b|fmt\.Print/i, facts: ["T201", "forbidigo"] },
  { key: "eqeqeq", words: /===|!==|strict equality|loose equality|严格相等|双等号|三等号/i, facts: ["eqeqeq"] },
  { key: "var", words: /\bvar\b[^.\n]{0,20}\b(?:let|const)\b|\bno var\b|不要用 ?var/i, facts: ["no-var"] },
  {
    key: "import-order",
    words: /import (?:order|sorting)|sort(?:ed)? imports|imports? (?:should|must) be sorted|import ?(?:顺序|排序)|导入(?:顺序|排序)/i,
    facts: ["import/order", "simple-import-sort/imports", "perfectionist/sort-imports", "I001", "I", "isort", "gci", "goimports"],
    category: "lint",
  },
  {
    key: "format",
    words: /\bformat(?:ting|ted)?\b|\bindent(?:ation)?\b|trailing (?:whitespace|spaces?|commas?)|\bwhitespace\b|格式|缩进|空格|行尾|换行/i,
    facts: ["prettier/prettier", "W291", "W293", "Layout/TrailingWhitespace", "gofmt", "gofumpt"],
    category: "format",
  },
  {
    key: "line-length",
    words: /line length|lines? (?:too )?long|long lines|max(?:imum)? line|行(?:太)?长|每行[^。\n]{0,8}字符/i,
    facts: ["max-len", "E501", "Layout/LineLength", "lll", "line-length"],
    category: "lint",
  },
  { key: "errcheck", words: /unchecked errors?|ignor(?:e|ed|ing) (?:the )?errors?|errors? (?:is|are) ignored|错误[^。\n]{0,6}(?:没|未|不)处理|忽略[^。\n]{0,6}错误|吞掉[^。\n]{0,6}(?:错误|异常)/i, facts: ["errcheck", "BLE001", "S110", "no-empty", "Lint/SuppressedException"] },
  { key: "unwrap", words: /\.unwrap\(\)|\bunwrap\b|\.expect\(/i, facts: ["clippy::unwrap_used", "clippy::expect_used"] },
  { key: "type-errors", words: /type errors?|type ?check|type safety|类型错误|类型检查|类型安全/i, facts: ["strict"], category: "typecheck" },
  { key: "tests", words: /\b(?:add|write|missing|need) (?:a |unit )?tests?\b|tests? (?:must|should) pass|测试(?:要|必须|得)?(?:通过|覆盖)|(?:补|加|写)[^。\n]{0,4}测试/i, facts: [], category: "test" },
  { key: "security", words: /\bsecrets?\b|\bpasswords?\b|\bcredentials?\b|sql injection|\bxss\b|\bcsrf\b|安全|注入|密钥|凭据/i, facts: ["S105", "S106", "G101", "gosec", "detect-secrets", "gitleaks"], category: "security" },
];

const CODE = /^[A-Z]{1,4}\d{0,4}$/;

/** 检查里的一条 fact 能不能算「管住了」想要的那条（大小写不敏感；ruff 这类代码前缀 F 管 F401；带命名空间的按最后一段）。 */
export function factCovers(have: string, want: string): boolean {
  const h = have.toLowerCase();
  const w = want.toLowerCase();
  if (h === w) return true;
  if (CODE.test(have) && /^[A-Z]{1,4}\d+$/.test(want) && want.startsWith(have) && /^\d+$/.test(want.slice(have.length))) return true;
  const tail = (s: string) => s.split(/::|\//).pop() ?? s;
  return h.includes("/") || h.includes("::") ? tail(h) === w || h === tail(w) : false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 规矩文字直接点名了检查配置里的一条规则。单字母的代码族（ruff 的 E / F / I）只认文字里的完整代码。 */
function namedFacts(text: string, facts: string[]): string[] {
  const out: string[] = [];
  const codes = [...text.matchAll(/\b([A-Z]{1,4}\d{2,4})\b/g)].map((m) => m[1]);
  for (const f of facts) {
    if (CODE.test(f) && f.length <= 2) {
      const c = codes.find((x) => factCovers(f, x));
      if (c) out.push(c);
      continue;
    }
    if (f.length < 3) continue;
    const names = [f, ...(f.includes("/") || f.includes("::") ? [f.split(/::|\//).pop() ?? f] : [])].filter((n) => n.length >= 3);
    if (names.some((n) => new RegExp(`(^|[^\\w-])${escapeRe(n)}($|[^\\w-])`, "i").test(text))) out.push(f);
  }
  return out;
}

/** 规矩的路径范围和检查的项目目录有没有交集（没写范围 = 整个仓库）。 */
export function globsOverlapDir(globs: string[] | undefined, dir: string): boolean {
  if (!globs || !globs.length || !dir) return true;
  return globs.some((raw) => {
    const g = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!g.includes("/") || g.startsWith("**")) return true;
    const fixed = g.slice(0, g.search(/[*?[{]/) === -1 ? g.length : g.search(/[*?[{]/));
    return fixed.startsWith(`${dir}/`) || fixed === dir || `${dir}/`.startsWith(fixed);
  });
}

/** 一个仓库的检查里，管住这条规矩的（强的在前）。 */
export function coverageIn(slug: string, checks: BaselineCheck[], text: string, globs?: string[]): BaselineCoverage[] {
  const out: BaselineCoverage[] = [];
  for (const check of checks) {
    if (!globsOverlapDir(globs, check.dir)) continue;
    const named = namedFacts(text, check.facts);
    if (named.length) {
      out.push({ slug, dir: check.dir, check, via: "fact", matched: named[0], strength: "strong" });
      continue;
    }
    for (const c of CONCEPTS) {
      if (!c.words.test(text)) continue;
      const fact = c.facts.find((want) => check.facts.some((have) => factCovers(have, want)));
      if (fact) {
        out.push({ slug, dir: check.dir, check, via: "concept", matched: `${c.key}:${fact}`, strength: "strong" });
        break;
      }
      if (c.category && c.category === check.category) {
        out.push({ slug, dir: check.dir, check, via: "concept", matched: `${c.key}:${c.category}`, strength: "weak" });
        break;
      }
    }
  }
  const conf = (c: BaselineCheck) => (c.confidence === "high" ? 0 : c.confidence === "medium" ? 1 : 2);
  return out.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === "strong" ? -1 : 1) || conf(a.check) - conf(b.check));
}
