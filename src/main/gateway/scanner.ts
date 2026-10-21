import type { ScanHit, ScanRule } from "../../shared/llm";
import { normalizeText, PLACEHOLDER_RE } from "./pseudonym";

export const DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-\\d+";
/** 长得像 ticket 号、其实是标准或算法名的写法。 */
const NOT_TICKETS = /^(?:UTF|ISO|SHA|AES|RSA|HTTP|TLS|SSL|ES|ECMA|RFC|CVE|IEEE|GB|COVID|MD|IPV|WCAG|PEP|JSR)-\d+$/i;

interface Rule {
  rule: ScanRule;
  re: RegExp;
}

/**
 * 都是全局正则（只用 match / matchAll，不用 test / exec，所以不受 lastIndex 影响）。
 * 路径规则带前导边界字符，命中样本会 trim。
 * 防回溯：所有可能在长输入上从每个位置重试的量词都有上界（{1,64} 之类），
 * 没有嵌套量词；上界之外的串换个起点仍会命中（比如超深路径的末尾 20 段）。
 */
const RULES: Rule[] = [
  { rule: "secret", re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g },
  { rule: "secret", re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g },
  { rule: "secret", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { rule: "secret", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { rule: "secret", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "secret", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "secret", re: /\beyJ[A-Za-z0-9_-]{8,300}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { rule: "secret", re: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s?[:=]\s?\S{6,}/gi },
  { rule: "secret", re: /(?:密码|口令|密钥|令牌)\s?[:：=]\s?\S{4,}/g },
  { rule: "secret", re: /\b[A-Fa-f0-9]{32,}\b/g },
  { rule: "url", re: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>）)]+/gi },
  { rule: "url", re: /\bwww\.[a-z0-9-]{1,63}\.[a-z]{2,}/gi },
  { rule: "email", re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g },
  { rule: "ip", re: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g },
  { rule: "ip", re: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi },
  { rule: "domain", re: /\b(?:[a-z0-9-]{1,63}\.){1,8}(?:internal|corp|local|lan|intranet|intra|private|localdomain)\b/gi },
  { rule: "domain", re: /\b(?:[a-z0-9-]{1,63}\.){1,8}(?:com|net|org|io|dev|cn|ai|cloud|info|biz)\b/gi },
  { rule: "path", re: /(?:^|[\s"'`(（=:：])(?:~|\.{1,2})?\/(?:[\w.@-]{1,100}\/){1,30}[\w.@-]{0,100}/g },
  { rule: "path", re: /(?:^|[\s"'`(（=:：])(?:~|\.{1,2})\/[\w.@-]+/g },
  { rule: "path", re: /\b[A-Za-z]:\\[^\s"'<>|]+/g },
  { rule: "path", re: /\\\\[\w.-]{1,100}\\[^\s"'<>|]+/g },
  {
    rule: "path",
    re: /\b(?:[\w.-]{1,100}\/){1,20}[\w-]{1,100}\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|php|cs|cpp|cc|c|h|hpp|swift|scala|sql|sh|ps1|ya?ml|json|toml|ini|env|md|html|css|scss|vue|svelte|xml|gradle|proto|tf)\b/gi,
  },
];

/** 40 位以上、同时有数字和大小写字母、没有空白的串（base64 / 随机 token）。先按字符类切段再检查，线性。 */
const LONG_TOKEN_RE = /[A-Za-z0-9+/_-]{40,}/g;
const looksRandom = (s: string): boolean => /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);

export interface ScanOptions {
  /**
   * 设置里的 ticket 号正则；null 表示不查（full 档位本来就发真实 ticket 号）。
   * 已知限制：扫描前文本已规范化（en dash 等折成 "-"，\t 折成空格），
   * 所以自定义正则里写了字面 en dash 或 \t 的话匹配不上。不处理。
   */
  ticketPattern: string | null;
  /** 本次请求字典里的原值：假名化之后还出现就是漏网了（full 档位传空）。 */
  originals: readonly string[];
}

/** 打码样本：前 3 个字符 + 长度。审计页靠它定位问题，又不把敏感内容原样存下来。 */
export function maskSample(s: string): string {
  const chars = [...s];
  return `${chars.slice(0, 3).join("")}…(${chars.length})`;
}

function ticketRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "g");
  } catch {
    return new RegExp(DEFAULT_TICKET_PATTERN, "g");
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 字典原值的匹配器，写法和 Pseudonymizer 一致：规范化、不分大小写、"-" 两侧允许空白。 */
function knownRegExp(originals: readonly string[]): RegExp | null {
  const norm = [...new Set(originals.map((v) => normalizeText(v).trim()).filter((v) => v.length > 0))];
  if (!norm.length) return null;
  return new RegExp(norm.map((v) => escapeRe(v).replace(/-/g, "\\s*-\\s*")).join("|"), "giu");
}

/** 自定义 ticket 正则可能在长串上二次方回溯：超过 WINDOW 的文本按窗口（带重叠）扫，每个窗口的代价有上界。 */
const WINDOW = 256;
const STEP = 192;
function* windows(text: string): Generator<string> {
  if (text.length <= WINDOW) {
    yield text;
    return;
  }
  for (let i = 0; i < text.length; i += STEP) {
    yield text.slice(i, i + WINDOW);
    if (i + WINDOW >= text.length) return;
  }
}

function findTicket(text: string, re: RegExp): string | null {
  for (const w of windows(text)) {
    for (const m of w.matchAll(re)) {
      if (m[0] !== "" && !NOT_TICKETS.test(m[0])) return m[0];
    }
  }
  return null;
}

/** 扫描全部出站文本。返回的命中按规则去重；空数组表示可以发。 */
export function scanOutbound(texts: readonly string[], o: ScanOptions): ScanHit[] {
  const hits: ScanHit[] = [];
  const seen = new Set<ScanRule>();
  const add = (rule: ScanRule, sample: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    hits.push({ rule, sample: maskSample(sample) });
  };
  const ticketRe = o.ticketPattern === null ? null : ticketRegExp(o.ticketPattern);
  const knownRe = knownRegExp(o.originals);
  // 每次调用新建正则，PLACEHOLDER_RE 的 lastIndex 状态不会带进来。
  const placeholderRe = new RegExp(PLACEHOLDER_RE.source, "g");
  for (const raw of texts) {
    // 和假名化用同一个规范化；占位符本身不算命中，换成空格免得两边的字粘成一个词。
    const text = normalizeText(raw).replace(placeholderRe, " ");
    for (const r of RULES) {
      const m = text.match(r.re);
      if (m) add(r.rule, m[0].trim());
    }
    for (const m of text.matchAll(LONG_TOKEN_RE)) {
      if (looksRandom(m[0])) {
        add("secret", m[0]);
        break;
      }
    }
    if (ticketRe) {
      const t = findTicket(text, ticketRe);
      if (t !== null) add("ticket", t);
    }
    if (knownRe) {
      const m = text.match(knownRe);
      if (m) add("known", m[0]);
    }
  }
  return hits;
}
