import { renderBranch } from "../../shared/branch";
import { LANG_SETTINGS } from "../../shared/i18n";
import { isAbsolute } from "node:path";
import vm from "node:vm";
import { PRIVACY_LEVELS, TERM_CATEGORIES, type PrivacyLevel, type SensitiveTerm, type TermCategory } from "../../shared/llm";
import type { EditableSettingKey } from "../../shared/settings";
import { SETTING_DEFAULTS, type SettingsRepo } from "../db/settings-repo";

export class SettingError extends Error {
  readonly code = "invalid_setting";
}

export interface ScheduleConfig {
  nightly: { h: number; m: number };
  workingDays: ReadonlySet<number>;
}

export interface Thresholds {
  blockedDays: number;
  reviewWaitDays: number;
  staleDays: number;
}

export function parseTime(v: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

/** 不认识的项直接忽略。 */
export function parseWorkingDays(v: string): Set<number> {
  return new Set(v.split(/[\s,]+/).filter((t) => /^[0-6]$/.test(t)).map(Number));
}

/** 逗号、换行或括号外的空白分隔；`Bash(git status)` 括号里的空格保留。去重，保持顺序。 */
export function parseToolList(v: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  const flush = () => {
    const t = cur.trim();
    if (t && !out.includes(t)) out.push(t);
    cur = "";
  };
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) flush();
    else cur += ch;
  }
  flush();
  return out;
}

/** tracker 工具只能是 MCP 工具名（mcp__server 或 mcp__server__tool）：Bash、带参数的规则、以 - 开头的 flag 一律不是。 */
export const TRACKER_TOOL_RE = /^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?$/;

export function parseDays(v: string, fallback: number): number {
  const t = v.trim();
  return /^\d{1,3}$/.test(t) ? Number(t) : fallback;
}

/** 开关类设置：只接受 0 / 1。 */
export function normalizeFlag(value: string): string {
  const t = value.trim();
  if (t !== "0" && t !== "1") throw new SettingError("开关只能是 0 或 1");
  return t;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** URL.hostname 是不是本机（Ollama 之类的本地服务可以用 http、可以不配 key）。 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** OpenAI 兼容接口的 base URL：https（本机可以 http），不带账号、查询串和 #；去掉末尾的 / 和 /chat/completions。 */
export function normalizeBaseUrl(v: string): string {
  const t = v.trim();
  if (!t) return "";
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new SettingError("base URL 格式不对，例如 https://api.deepseek.com/v1");
  }
  if (u.username || u.password) throw new SettingError("base URL 里不能带用户名或密码");
  if (u.search || u.hash) throw new SettingError("base URL 不能带 ? 或 # 部分");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    throw new SettingError("base URL 必须是 https://（本机服务如 Ollama 可以用 http://localhost）");
  }
  const path = u.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

export interface PriceRule {
  /** 模型名，* 匹配任意字符，不区分大小写。 */
  pattern: string;
  /** 美元 / 百万 token。 */
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICE_NUM = /^\d{1,6}(\.\d{1,6})?$/;
const PRICE_MODEL = /^[A-Za-z0-9._:/@*+-]{1,200}$/;

/** 每行“模型 输入价 输出价”；空行和 # 开头的行忽略。格式不对时抛 SettingError（指出第几行）。 */
export function parsePriceTable(v: string): PriceRule[] {
  const rules: PriceRule[] = [];
  v.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/\s+/);
    if (parts.length !== 3 || !PRICE_MODEL.test(parts[0]) || !PRICE_NUM.test(parts[1]) || !PRICE_NUM.test(parts[2])) {
      throw new SettingError(`价格表第 ${i + 1} 行格式不对，应为“模型 输入价 输出价”（美元 / 百万 token），例如 deepseek-chat 0.27 1.1`);
    }
    rules.push({ pattern: parts[0], inputPerMTok: Number(parts[1]), outputPerMTok: Number(parts[2]) });
  });
  return rules;
}

/** 线性回溯的通配匹配（只有 *），不区分大小写；不用正则，病态模式也不会指数膨胀。 */
function globMatch(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = ti;
    } else if (pi < p.length && p[pi] === t[ti]) {
      pi++;
      ti++;
    } else if (star >= 0) {
      pi = star + 1;
      ti = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/** 从上往下第一条匹配的价格；没有匹配时为 null（不会调用）。 */
export function priceFor(rules: readonly PriceRule[], model: string): PriceRule | null {
  return rules.find((r) => globMatch(r.pattern, model)) ?? null;
}

export const TERMS_LIMIT = 500;

/** 设置页提交的敏感词表：NFKC、压缩空白、去掉空项和只差大小写的重复项；太短、太长、太多或格式不对时抛 SettingError。 */
export function normalizeTerms(input: unknown): SensitiveTerm[] {
  if (!Array.isArray(input)) throw new SettingError("敏感词表格式不对");
  const out: SensitiveTerm[] = [];
  const seen = new Set<string>();
  for (const x of input) {
    const o = x as { term?: unknown; category?: unknown } | null;
    if (!o || typeof o.term !== "string" || !(TERM_CATEGORIES as readonly string[]).includes(String(o.category))) {
      throw new SettingError("敏感词表格式不对");
    }
    const term = o.term.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!term) continue;
    if ([...term].length < 2) throw new SettingError(`敏感词至少两个字：${term}`);
    if (term.length > 100) throw new SettingError(`敏感词太长（上限 100 字）：${term.slice(0, 20)}…`);
    const k = term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ term, category: o.category as TermCategory });
  }
  if (out.length > TERMS_LIMIT) throw new SettingError(`敏感词最多 ${TERMS_LIMIT} 个`);
  return out;
}

function branchNameBad(name: string): boolean {
  return (
    !/^[A-Za-z0-9._/-]+$/.test(name) ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("/.")
  );
}

/** 模板代入时用的标题样例：没有标题，和一个普通的英文标题。 */
const TITLE_SAMPLES = ["", "Add payment API"];

/**
 * 分支名模板（设计文档 4.1、2026-10-26）：必须含 {key} 或 {key_lower}；代入一个 ticket 号（和有、没有标题两种情况）之后
 * 要是 git 接受的分支名（保守的子集）。
 */
export function normalizeBranchTemplate(value: string): string {
  const t = value.trim();
  if (!t.includes("{key}") && !t.includes("{key_lower}")) throw new SettingError("分支名模板必须包含 {key} 或 {key_lower}，例如 feature/{key}");
  if (t.length > 100 || TITLE_SAMPLES.some((title) => branchNameBad(renderBranch(t, "PROJ-1", title)))) {
    throw new SettingError("分支名模板只能用字母、数字和 . _ / -（不能以 - 或 / 开头、不能有 .. 或 //），最长 100 字，例如 feature/{key}");
  }
  return t;
}

/** 这些样例里能被 ticket 号正则匹配的，代入模板之后也都要是合法分支名（例如正则 `-\d+` 配模板 `{key}` 会得到以 - 开头的名字）。 */
const KEY_SAMPLES = ["PROJ-1", "-1", "-PROJ-1", "1-1", "A_B-1", "#1", "A.B-1", "..-1"];

export function checkBranchTemplateFits(template: string, ticketPattern: string): void {
  let anchored: RegExp;
  try {
    anchored = new RegExp(`^(?:${ticketPattern})$`);
  } catch {
    return;
  }
  for (const key of KEY_SAMPLES) {
    if (!anchored.test(key)) continue;
    for (const title of TITLE_SAMPLES) {
      const branch = renderBranch(template, key, title);
      if (branchNameBad(branch)) throw new SettingError(`分支名模板和 ticket 号正则搭配起来会得到不合法的分支名（例如 ${branch}），请调整其中之一`);
    }
  }
}

/** 回溯保护：候选正则在隔离的 vm 里跑，超时由 V8 强行中断（普通的计时测量没法打断正在回溯的正则）。 */
const PROBE_TIMEOUT_MS = 250;
const PROBE_LENGTH = 5000;

/** 长对抗输入：一长串能匹配的字符，后面接一个让匹配失败的字符；再加交替和 `A…-` 后接非数字的形状。 */
function adversarialInputs(pattern: string): string[] {
  const seeds = new Set(["A", "a", "1", "-", " ", "AB", "A1", "A-", "1-"]);
  // 模式自己的第一个字符类的起点或第一个字面量，让探针更贴近模式。
  const first = /^(?:\(\?:)?(?:\[([^\]\\^])|([A-Za-z0-9#_]))/.exec(pattern);
  const own = first?.[1] ?? first?.[2];
  if (own) seeds.add(own);
  const out: string[] = [];
  for (const seed of seeds) {
    const run = seed.repeat(Math.ceil(PROBE_LENGTH / seed.length)).slice(0, PROBE_LENGTH);
    out.push(`${run}!`, `${run}-x`, `${run}-`, `${run}\n`);
  }
  out.push("AB1-".repeat(PROBE_LENGTH / 4) + "!", "A-".repeat(PROBE_LENGTH / 2) + "x", `${"A".repeat(PROBE_LENGTH)}-!`);
  return out;
}

/** 每个探针各有 250ms 的硬超时；超时说明回溯超线性。 */
function backtracksBadly(pattern: string): boolean {
  const ctx = vm.createContext({ input: "" });
  vm.runInContext(
    `globalThis.a = null; globalThis.b = null;
     globalThis.src = ${JSON.stringify(pattern)};
     globalThis.a = new RegExp("^(?:" + src + ")$");
     globalThis.b = new RegExp("(?<![A-Za-z0-9])(?:" + src + ")(?![0-9])", "i");`,
    ctx,
  );
  const run = new vm.Script("a.test(input); b.test(input);");
  try {
    for (const input of adversarialInputs(pattern)) {
      ctx.input = input;
      run.runInContext(ctx, { timeout: PROBE_TIMEOUT_MS });
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * ticket 号正则（设计文档 4.4、12）：在扫描器、session 发现和建 ticket 里反复执行，保存前挡住
 * 写错的、能匹配空字符串的、带反向引用的、以及回溯会超线性增长的写法（计划 3 遗留的 ReDoS 检查）。
 */
export function normalizeTicketPattern(value: string): string {
  const t = value.trim();
  if (!t || t.length > 100) throw new SettingError("ticket 号正则不能为空，最长 100 字");
  let anchored: RegExp;
  try {
    anchored = new RegExp(`^(?:${t})$`);
    new RegExp(`(?<![A-Za-z0-9])(?:${t})(?![0-9])`, "i");
  } catch {
    throw new SettingError("ticket 号正则写法不对");
  }
  if (/\\[1-9]|\\k</.test(t)) throw new SettingError("ticket 号正则不能用反向引用");
  if (anchored.test("")) throw new SettingError("ticket 号正则不能匹配空字符串");
  if (backtracksBadly(t)) throw new SettingError("ticket 号正则太慢（长文本上回溯可能卡死），请简化，例如去掉连续或嵌套的 + / *");
  return t;
}

/** 渲染进程提交的设置值：规范化后返回，不合法时抛 SettingError（界面显示 message）。 */
export function normalizeSetting(key: EditableSettingKey, value: string): string {
  switch (key) {
    case "nightlyTime": {
      const t = parseTime(value);
      if (!t) throw new SettingError("时间格式应为 HH:MM，例如 16:00");
      return `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
    }
    case "workingDays": {
      const tokens = value.split(/[\s,]+/).filter(Boolean);
      if (tokens.some((t) => !/^[0-6]$/.test(t))) throw new SettingError("工作日只能是 0–6（0 是周日）");
      return [...new Set(tokens.map(Number))].sort((a, b) => a - b).join(",");
    }
    case "trackerTools": {
      const tools = parseToolList(value);
      const bad = tools.find((t) => !TRACKER_TOOL_RE.test(t));
      if (bad !== undefined) throw new SettingError(`tracker 工具只能是 MCP 工具名（mcp__server__tool），不接受：${bad.slice(0, 60)}`);
      return tools.join("\n");
    }
    case "headlessProjectMcp":
      return normalizeFlag(value);
    case "blockedDays":
    case "reviewWaitDays":
    case "staleDays":
      if (!/^\d{1,3}$/.test(value.trim())) throw new SettingError("天数必须是 0–999 的整数");
      return String(Number(value.trim()));
    case "handoffPrompt":
    case "refreshPrompt":
      if (!value.trim()) throw new SettingError("prompt 模板不能为空");
      if (value.length > 20_000) throw new SettingError("prompt 模板太长（上限 20000 字）");
      return value;
    case "llmLevel": {
      const t = value.trim();
      if (!(PRIVACY_LEVELS as readonly string[]).includes(t)) throw new SettingError("隐私档位只能是 off、metadata、redacted、full");
      return t;
    }
    case "llmBaseUrl":
      return normalizeBaseUrl(value);
    case "llmModel": {
      const t = value.trim();
      // eslint-disable-next-line no-control-regex
      if (t && !/^[^\s\u0000-\u001f\u007f]{1,200}$/.test(t)) throw new SettingError("模型名不能有空格，最长 200 字，例如 deepseek-chat");
      return t;
    }
    case "llmMonthlyBudgetUsd": {
      const t = value.trim();
      if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) throw new SettingError("预算是美元金额，例如 1 或 2.50");
      return String(Number(t));
    }
    case "llmPrices":
      return parsePriceTable(value).map((r) => `${r.pattern} ${r.inputPerMTok} ${r.outputPerMTok}`).join("\n");
    case "llmConfirm":
      return normalizeFlag(value);
    case "auditRetentionDays": {
      const t = value.trim();
      if (!/^\d{1,4}$/.test(t) || Number(t) < 1 || Number(t) > 3650) throw new SettingError("保留天数是 1–3650 的整数");
      return String(Number(t));
    }
    case "claudePath": {
      const t = value.trim();
      if (!t) return "";
      // eslint-disable-next-line no-control-regex
      if (t.length > 1000 || /[\u0000-\u001f\u007f]/.test(t) || !isAbsolute(t)) {
        throw new SettingError("claude 路径必须是绝对路径，例如 /usr/local/bin/claude；留空则自动查找");
      }
      return t;
    }
    case "branchTemplate":
      return normalizeBranchTemplate(value);
    case "ticketPattern":
      return normalizeTicketPattern(value);
    case "memoryEnabled":
    case "onboardingDone":
      return normalizeFlag(value);
    case "language": {
      const t = value.trim();
      if (!(LANG_SETTINGS as readonly string[]).includes(t)) throw new SettingError("语言只能是 auto、zh 或 en");
      return t;
    }
    default: {
      // IPC 层已经用 isEditableSetting 拦过；这里再兜一次，免得以后新增的调用方绕过。
      const unknown: never = key;
      throw new SettingError(`这个设置不能在这里修改：${String(unknown)}`);
    }
  }
}

export function scheduleConfig(s: SettingsRepo): ScheduleConfig {
  // 工作日解析出空集合（损坏的值）会让晚间任务永远不跑，所以回退到默认。
  const days = parseWorkingDays(s.get("workingDays"));
  return {
    nightly: parseTime(s.get("nightlyTime")) ?? { h: 16, m: 0 },
    workingDays: days.size > 0 ? days : parseWorkingDays(SETTING_DEFAULTS.workingDays),
  };
}

export function thresholds(s: SettingsRepo): Thresholds {
  return {
    blockedDays: parseDays(s.get("blockedDays"), 2),
    reviewWaitDays: parseDays(s.get("reviewWaitDays"), 2),
    staleDays: parseDays(s.get("staleDays"), 5),
  };
}

/** 记忆开关（memoryEnabled）：只有明确存成 "0" 才算关（默认开）。所有读这个开关的地方都用它。 */
export function memoryOn(s: Pick<SettingsRepo, "get">): boolean {
  return s.get("memoryEnabled") !== "0";
}

export function trackerTools(s: SettingsRepo): string[] {
  // 读取时再过滤一次：存储的值损坏或被改过，也不会把任意 flag / 工具带进 --allowedTools。
  return parseToolList(s.get("trackerTools")).filter((t) => TRACKER_TOOL_RE.test(t));
}

export interface LlmConfig {
  level: PrivacyLevel;
  /** 规范化后的 base URL；没配置或存储的值不合法时为 ""。 */
  baseUrl: string;
  model: string;
  budgetUsd: number;
  prices: PriceRule[];
  confirm: boolean;
  retentionDays: number;
}

/** 与 normalizeSetting 同一个范围：1–3650 的整数，否则回退 90。 */
function parseRetentionDays(v: string): number {
  const t = v.trim();
  const n = Number(t);
  return /^\d{1,4}$/.test(t) && n >= 1 && n <= 3650 ? n : 90;
}

function safely<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/** 读取时一律往保守方向回退：档位坏了当作 off，价格表坏了当作空（不会调用），预算坏了当作 0。 */
export function llmConfig(s: SettingsRepo): LlmConfig {
  const level = s.get("llmLevel");
  const baseUrl = safely(() => normalizeBaseUrl(s.get("llmBaseUrl")), "");
  const prices = safely(() => parsePriceTable(s.get("llmPrices")), []);
  const budget = Number(s.get("llmMonthlyBudgetUsd"));
  return {
    level: (PRIVACY_LEVELS as readonly string[]).includes(level) ? (level as PrivacyLevel) : "off",
    baseUrl,
    model: s.get("llmModel").trim(),
    budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 0,
    prices,
    confirm: s.get("llmConfirm") === "1",
    retentionDays: parseRetentionDays(s.get("auditRetentionDays")),
  };
}
