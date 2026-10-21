import type { ScanHit, ScanRule } from "../../shared/llm";
import { normalizeText, PLACEHOLDER_RE } from "./pseudonym";

export const DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-\\d+";
/** 长得像 ticket 号、其实是标准或算法名的写法。 */
const NOT_TICKETS = /^(?:UTF|ISO|SHA|GPT|AES|RSA|HTTP|TLS|SSL|ES|ECMA|RFC|CVE|IEEE|GB|COVID|MD|IPV|WCAG|PEP|JSR)-\d+$/i;

interface Rule {
  rule: ScanRule;
  re: RegExp;
  /** 额外过滤：正则命中后还要通过它才算（取第一个通过的命中）。 */
  accept?: (match: string) => boolean;
}

/**
 * 域名判定用精选 TLD 集，不是“任意 2 到 24 个字母”：代码里 `this.state`、`Array.from`、`path.join` 到处都是 label.label。
 * 已接受的代价：用了集合之外 TLD 的公司主机名，域名规则抓不到（带协议的 URL 仍由 url 规则抓）。
 */
const GTLDS = new Set(
  "com net org io ai co xyz tech biz gov edu mil arpa internal corp lan intranet club shop pro mobi asia".split(" "),
);
/** 同时是常见代码成员的 gTLD（this.app、user.name、logger.info）：至少 3 段才算。 */
const AMBIGUOUS_GTLDS = new Set("app dev home local cloud site online info name store top int".split(" "));
/** 不含 id in is it at to do me no so as be by on am pm us 这类像代码成员的 ccTLD；它们只能靠下面的二级形式抓。 */
const CCTLDS = new Set(
  "cn uk de jp fr kr ru ca au nl se ch sg hk tw eu br es pl dk fi nz ie il za mx ar tr ua cz".split(" "),
);
const SECOND_LEVELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
function isDomain(m: string): boolean {
  const parts = m.toLowerCase().split(".");
  const n = parts.length;
  const tld = parts[n - 1] ?? "";
  if (GTLDS.has(tld) || CCTLDS.has(tld)) return true;
  if (AMBIGUOUS_GTLDS.has(tld)) return n >= 3;
  return n >= 3 && tld.length === 2 && SECOND_LEVELS.has(parts[n - 2] ?? "");
}
const hasDigit = (m: string): boolean => /\d/.test(m);

/**
 * 都是全局正则（只用 match / matchAll，不用 test / exec，所以不受 lastIndex 影响）。
 * 路径规则带前导边界字符，命中样本会 trim。
 * 防回溯：所有可能在长输入上从每个位置重试的量词都有上界（{1,64} 之类），
 * 没有嵌套量词；上界之外的串换个起点仍会命中（比如超深路径的末尾 20 段）。
 */
const RULES: Rule[] = [
  { rule: "secret", re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g },
  { rule: "secret", re: /\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{16,}/g },
  { rule: "secret", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { rule: "secret", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { rule: "secret", re: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g },
  { rule: "secret", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "secret", re: /\beyJ[A-Za-z0-9_-]{8,300}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { rule: "secret", re: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s?[:=]\s?\S{6,}/gi },
  { rule: "secret", re: /(?:密码|口令|密钥|秘钥|令牌)\s?[:：=]\s?\S{4,}/g },
  // 密码是hunter2024：分隔符（是 / 为）之后跟 6 位以上的 ASCII 可见字符。
  { rule: "secret", re: /(?:密码|口令|密钥|秘钥|令牌)\s?[是为]\s?[\x21-\x7e]{6,}/g },
  // 密码 hunter2024：没有分隔符时值里必须有数字，免得 "密钥 rotation 完成" 这类描述误伤。
  { rule: "secret", re: /(?:密码|口令|密钥|秘钥|令牌)\s?(?=[\x21-\x7e]*\d)[\x21-\x7e]{6,}/g },
  // password is hunter2024：值里要有数字，免得 "token is expired" 误伤。
  { rule: "secret", re: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|pwd|passcode|token)\s(?:is|was)\s(?=\S*\d)\S{6,}/gi },
  { rule: "secret", re: /\b(?:authorization\s?[:=]\s?)?(?:Bearer|Basic)\s(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/g },
  { rule: "secret", re: /\bauthorization\s?[:=]\s?\S{8,}/gi },
  { rule: "secret", re: /\b[A-Fa-f0-9]{32,}\b/g },
  { rule: "url", re: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>）)]+/gi },
  { rule: "url", re: /\bwww\.[a-z0-9-]{1,63}\.[a-z]{2,}/gi },
  { rule: "email", re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g },
  { rule: "ip", re: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g },
  { rule: "ip", re: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi },
  // 压缩写法（带 ::）：2001:db8::1、fe80::1%en0、::1、2001:db8::/32；必须含数字，std::vector、a::b 不算。
  {
    rule: "ip",
    re: /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){1,7}:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}|(?:[0-9a-f]{1,4}:){2,7}:)(?![\w:])/gi,
    accept: hasDigit,
  },
  { rule: "domain", re: /\b(?:[a-z0-9-]{1,63}\.){1,8}(?:internal|corp|lan|intranet|localdomain)\b/gi },
  // 任意 label.label.tld（tld 2 到 24 个字母），去掉长得像文件扩展名的。
  { rule: "domain", re: /\b(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24}(?![A-Za-z0-9_])/gi, accept: isDomain },
  // 盘符路径（C:\ 或 C:/）放在最前，样本才带盘符。
  { rule: "path", re: /\b[A-Za-z]:[\\/][^\s"'<>|]+/g },
  // 前导边界用 lookbehind：中文紧贴路径（改一下/etc/hosts）也要命中，A/B、3/4 前面是单词字符所以不会。
  { rule: "path", re: /(?<![\w.@~-])(?:~|\.{1,2})?\/(?:[\w.@-]{1,100}\/){1,30}[\w.@-]{0,100}/g },
  { rule: "path", re: /(?<![\w.@~-])(?:~|\.{1,2})\/[\w.@-]+/g },
  { rule: "path", re: /\\\\[\w.-]{1,100}\\[^\s"'<>|]+/g },
  { rule: "path", re: /(?<![\w:/])\/\/[\w.-]{1,100}\/[\w.$-]{1,100}/g },
  { rule: "path", re: /\$\{?[A-Za-z_][A-Za-z0-9_]{0,31}\}?\/[\w.@-]{1,100}/g },
  {
    rule: "path",
    re: /\b(?:[\w.-]{1,100}\/){1,20}[\w-]{1,100}\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|php|cs|cpp|cc|c|h|hpp|swift|scala|sql|sh|ps1|ya?ml|json|toml|ini|env|conf|log|pem|key|cfg|md|html|css|scss|vue|svelte|xml|gradle|proto|tf)\b/gi,
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
function* windows(text: string): Generator<[string, number]> {
  if (text.length <= WINDOW) {
    yield [text, 0];
    return;
  }
  for (let i = 0; i < text.length; i += STEP) {
    yield [text.slice(i, i + WINDOW), i];
    if (i + WINDOW >= text.length) return;
  }
}

function findTicket(text: string, re: RegExp): string | null {
  for (const [w, offset] of windows(text)) {
    for (const m of w.matchAll(re)) {
      if (m[0] === "" || NOT_TICKETS.test(m[0])) continue;
      // 窗口切断了一个词（SHA-256 切成 HA-256）：整词在前一个窗口里已经检查过。
      if (offset > 0 && m.index === 0 && /[A-Za-z0-9]/.test(text[offset - 1] ?? "")) continue;
      return m[0];
    }
  }
  return null;
}

/** 扫描全部出站文本。返回的命中按规则去重；空数组表示可以发。 */
export function scanOutbound(texts: readonly string[], o: ScanOptions): ScanHit[] {
  const hits: ScanHit[] = [];
  const seen = new Set<ScanRule>();
  const add = (rule: ScanRule, sample: string, lengthOnly = false) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    hits.push({ rule, sample: lengthOnly ? `…(${[...sample].length})` : maskSample(sample) });
  };
  const ticketRe = o.ticketPattern === null ? null : ticketRegExp(o.ticketPattern);
  const knownRe = knownRegExp(o.originals);
  // 每次调用新建正则，PLACEHOLDER_RE 的 lastIndex 状态不会带进来。
  const placeholderRe = new RegExp(PLACEHOLDER_RE.source, "g");
  for (const raw of texts) {
    const norm = normalizeText(raw);
    // 两份副本：占位符换成空格（免得两边的字粘成词），和占位符整个删掉（把被占位符切开的密钥接回去）。任一份命中即拒发。
    for (const text of [norm.replace(placeholderRe, " "), norm.replace(placeholderRe, "")]) {
      for (const r of RULES) {
        if (seen.has(r.rule)) continue;
        if (!r.accept) {
          const m = text.match(r.re);
          if (m) add(r.rule, m[0].trim());
          continue;
        }
        for (const m of text.matchAll(r.re)) {
          if (r.accept(m[0])) {
            add(r.rule, m[0].trim());
            break;
          }
        }
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
        // 只记长度：字典原值（人名、项目代号）连前 3 个字符都不能进审计。
        if (m) add("known", m[0], true);
      }
    }
  }
  return hits;
}
