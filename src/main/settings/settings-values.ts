import { renderBranch } from "../../shared/branch";
import { LANG_SETTINGS } from "../../shared/i18n";
import { isAbsolute } from "node:path";
import vm from "node:vm";
import { isAutomationLevel } from "../../shared/automation";
import type { EditableSettingKey } from "../../shared/settings";
import { SETTING_DEFAULTS, type SettingsRepo } from "../db/settings-repo";
import { M } from "../strings";
import { NOTIFY_EVENTS, NOTIFY_FORMATS } from "../../shared/interrupts";
import { INTAKE_SOURCES } from "../../shared/intake";
import { isAbsolutePath, parseRepoMap } from "../intake/repo-map";
import { normalizeRoutingSetting, RoutingSettingError } from "../routing/routing-settings";
import { BgSettingError, normalizeBgSetting } from "../background/bg-settings";

export class SettingError extends Error {
  readonly code = "invalid_setting";
}

export interface ScheduleConfig {
  nightly: { h: number; m: number };
  workingDays: ReadonlySet<number>;
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

/** 外部通知的事件（ws-j）：逗号分隔，去重，按固定顺序；空 = 一个都不推。 */
export function normalizeNotifyEvents(value: string): string {
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => !(NOTIFY_EVENTS as readonly string[]).includes(p))) throw new SettingError(M().interrupts.notifyEvents);
  return NOTIFY_EVENTS.filter((e) => parts.includes(e)).join(",");
}

/** 安静时段（ws-j）：HH:MM-HH:MM，可以跨午夜；空 = 没有。开始和结束一样也不算（不会全天安静）。 */
export function normalizeQuietHours(value: string): string {
  const t = value.trim();
  if (!t) return "";
  const m = /^(\S+)\s*-\s*(\S+)$/.exec(t);
  const a = m ? parseTime(m[1]!) : null;
  const b = m ? parseTime(m[2]!) : null;
  if (!a || !b || (a.h === b.h && a.m === b.m)) throw new SettingError(M().interrupts.quietHours);
  const f = (x: { h: number; m: number }) => `${String(x.h).padStart(2, "0")}:${String(x.m).padStart(2, "0")}`;
  return `${f(a)}-${f(b)}`;
}

/** 开关类设置：只接受 0 / 1。 */
export function normalizeFlag(value: string): string {
  const t = value.trim();
  if (t !== "0" && t !== "1") throw new SettingError(M().flagValue);
  return t;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** URL.hostname 是不是本机（webhook 只有发往本机时可以用 http）。 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
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
  if (!t.includes("{key}") && !t.includes("{key_lower}")) throw new SettingError(M().branchTemplateKey);
  if (t.length > 100 || TITLE_SAMPLES.some((title) => branchNameBad(renderBranch(t, "PROJ-1", title)))) {
    throw new SettingError(M().branchTemplateChars);
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
      if (branchNameBad(branch)) throw new SettingError(M().branchTemplatePattern(branch));
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
  if (!t || t.length > 100) throw new SettingError(M().patternLength);
  let anchored: RegExp;
  try {
    anchored = new RegExp(`^(?:${t})$`);
    new RegExp(`(?<![A-Za-z0-9])(?:${t})(?![0-9])`, "i");
  } catch {
    throw new SettingError(M().patternSyntax);
  }
  if (/\\[1-9]|\\k</.test(t)) throw new SettingError(M().patternBackref);
  if (anchored.test("")) throw new SettingError(M().patternEmpty);
  if (backtracksBadly(t)) throw new SettingError(M().patternSlow);
  return t;
}

/** 渲染进程提交的设置值：规范化后返回，不合法时抛 SettingError（界面显示 message）。 */
export function normalizeSetting(key: EditableSettingKey, value: string): string {
  switch (key) {
    case "nightlyTime": {
      const t = parseTime(value);
      if (!t) throw new SettingError(M().timeFormat);
      return `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
    }
    case "workingDays": {
      const tokens = value.split(/[\s,]+/).filter(Boolean);
      if (tokens.some((t) => !/^[0-6]$/.test(t))) throw new SettingError(M().workingDays);
      return [...new Set(tokens.map(Number))].sort((a, b) => a - b).join(",");
    }
    case "trackerTools": {
      const tools = parseToolList(value);
      const bad = tools.find((t) => !TRACKER_TOOL_RE.test(t));
      if (bad !== undefined) throw new SettingError(M().trackerTool(bad.slice(0, 60)));
      return tools.join("\n");
    }
    case "headlessProjectMcp":
      return normalizeFlag(value);
    case "handoffPrompt":
    case "refreshPrompt":
      if (!value.trim()) throw new SettingError(M().promptEmpty);
      if (value.length > 20_000) throw new SettingError(M().promptTooLong);
      return value;
    case "auditRetentionDays": {
      const t = value.trim();
      if (!/^\d{1,4}$/.test(t) || Number(t) < 1 || Number(t) > 3650) throw new SettingError(M().retention);
      return String(Number(t));
    }
    case "claudePath": {
      const t = value.trim();
      if (!t) return "";
      // eslint-disable-next-line no-control-regex
      if (t.length > 1000 || /[\u0000-\u001f\u007f]/.test(t) || !isAbsolute(t)) {
        throw new SettingError(M().claudePathAbsolute);
      }
      return t;
    }
    case "branchTemplate":
      return normalizeBranchTemplate(value);
    case "ticketPattern":
      return normalizeTicketPattern(value);
    case "memoryEnabled":
    case "onboardingDone":
    case "showOutsideSessions":
    case "updateCheckEnabled":
    case "autoResumeAfterRestart":
    case "checksEnabled":
    case "memoryMonitor":
    case "backgroundPriority":
    case "orphanCleanup":
    case "hibernateEnabled":
    case "hibernateEndWatchers":
    case "memoryPressureEnabled":
    case "sharedMcp":
    case "externalCommentReply":
    case "externalCommentResolve":
    case "externalPrDescriptionEdit":
    case "externalPrLabel":
    case "externalPrOpen":
    case "externalBranchPush":
    case "externalPrTitleEdit":
    case "externalForcePush":
    case "externalCiRerun":
    case "externalIssuePost":
    case "externalPushNotification":
    case "externalPrBriefPost":
    case "externalIntakeTrackerComment":
    case "externalIntakeTrackerStatus":
    case "externalPrReviewRequest":
    case "preReviewEnabled":
    case "lessonsAutoAdmit":
    case "lessonsPrinciples":
    case "lessonsCoreGuide":
    case "baselineAutoRescan":
    case "permissionProfiles":
    case "interruptChoiceRule":
    case "interruptChoiceDefaults":
    case "interruptSelfServe":
    case "notifyDetails":
      return normalizeFlag(value);
    case "automationLevel": {
      const t = value.trim();
      if (!isAutomationLevel(t)) throw new SettingError(M().automationLevel);
      return t;
    }
    case "notifyFormat": {
      const t = value.trim();
      if (!(NOTIFY_FORMATS as readonly string[]).includes(t)) throw new SettingError(M().interrupts.notifyFormat);
      return t;
    }
    case "notifyEvents":
      return normalizeNotifyEvents(value);
    case "notifyQuietHours":
      return normalizeQuietHours(value);
    case "hibernateYouMinutes":
    case "hibernateCiMinutes":
    case "hibernateReviewMinutes":
    case "hibernateIdleMinutes": {
      const t = value.trim();
      if (!HIBERNATE_MINUTES_RE.test(t) || (Number(t) !== 0 && Number(t) < MIN_HIBERNATE_MINUTES)) throw new SettingError(M().hibernateMinutes);
      return String(Number(t));
    }
    case "memoryPressureFreePercent": {
      const t = value.trim();
      if (!/^\d{1,2}$/.test(t) || Number(t) < 1 || Number(t) > MAX_PRESSURE_PERCENT) throw new SettingError(M().memoryPressureFreePercent);
      return String(Number(t));
    }
    case "refreshThresholdTokens": {
      const t = value.trim();
      if (!REFRESH_THRESHOLD_RE.test(t)) throw new SettingError(M().refreshThreshold);
      return String(Number(t));
    }
    case "shipherdPatrolTime": {
      if (!value.trim()) return "";
      const t = parseTime(value);
      if (!t) throw new SettingError(M().timeFormat);
      return `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
    }
    case "idleCloseMinutes": {
      const t = value.trim();
      if (!IDLE_CLOSE_RE.test(t) || (Number(t) !== 0 && Number(t) < MIN_IDLE_CLOSE_MINUTES)) throw new SettingError(M().idleCloseMinutes);
      return String(Number(t));
    }
    case "sessionMemoryReserveMb":
    case "sessionMemoryEstimateMb":
    case "sessionMaxRunning": {
      const t = value.trim();
      // 保留线留空 = 自动（物理内存的 10%，限在 512–2048 MB，见 autoReserveMb）。
      if (key === "sessionMemoryReserveMb" && t === "") return "";
      const [min, max] = SESSION_LIMITS[key];
      if (!/^\d{1,7}$/.test(t) || Number(t) < min || Number(t) > max) throw new SettingError(M()[key]);
      return String(Number(t));
    }
    case "configBackupIntervalDays":
    case "configExportReminderDays": {
      const t = value.trim();
      if (!/^\d{1,3}$/.test(t) || Number(t) > MAX_CONFIG_DAYS) throw new SettingError(key === "configBackupIntervalDays" ? M().configBackupIntervalDays : M().configExportReminderDays);
      return String(Number(t));
    }
    case "configBackupKeep": {
      const t = value.trim();
      if (!/^\d{1,3}$/.test(t) || Number(t) < 1) throw new SettingError(M().configBackupKeep);
      return String(Number(t));
    }
    case "checksEditTimeoutSec":
    case "checksPushTimeoutSec": {
      const t = value.trim();
      const [lo, hi] = key === "checksEditTimeoutSec" ? CHECKS_EDIT_RANGE : CHECKS_PUSH_RANGE;
      if (!/^\d{1,4}$/.test(t) || Number(t) < lo || Number(t) > hi) throw new SettingError(key === "checksEditTimeoutSec" ? M().checksEditTimeoutSec : M().checksPushTimeoutSec);
      return String(Number(t));
    }
    case "refreshMemoryMb": {
      const t = value.trim();
      if (!MEMORY_MB_RE.test(t) || (Number(t) !== 0 && Number(t) < MIN_REFRESH_MEMORY_MB)) throw new SettingError(M().refreshMemoryMb);
      return String(Number(t));
    }
    case "baselineInfer": {
      const t = value.trim();
      if (t !== "auto" && t !== "off") throw new SettingError(M().baselineInfer);
      return t;
    }
    case "baselineGuideChars":
    case "legacyScanMaxFiles": {
      const t = value.trim();
      const [lo, hi] = key === "baselineGuideChars" ? BASELINE_GUIDE_RANGE : LEGACY_FILES_RANGE;
      if (!/^\d{1,6}$/.test(t) || Number(t) < lo || Number(t) > hi) throw new SettingError(key === "baselineGuideChars" ? M().baselineGuideChars : M().legacyScanMaxFiles);
      return String(Number(t));
    }
    case "reviewRequestScope": {
      const t = value.trim();
      if (t !== "all" && t !== "registered") throw new SettingError(M().reviewRequestScope);
      return t;
    }
    case "language": {
      const t = value.trim();
      if (!(LANG_SETTINGS as readonly string[]).includes(t)) throw new SettingError(M().language);
      return t;
    }
    case "routingQuotas":
    case "routingThresholds":
    case "routingPeriodStartDay":
    case "routingEffort":
    case "routingMaxConcurrent":
    case "routingAutoSwitch":
      try {
        return normalizeRoutingSetting(key, value);
      } catch (e) {
        if (e instanceof RoutingSettingError) throw new SettingError(e.message);
        throw e;
      }
    case "bgWindow":
    case "bgHours":
    case "bgIdleMinutes":
    case "bgYield":
    case "bgQuotaOrder":
    case "bgPlentifulPercent":
    case "bgKinds":
      try {
        return normalizeBgSetting(key, value);
      } catch (e) {
        if (e instanceof BgSettingError) throw new SettingError(e.message);
        throw e;
      }
    case "intakeSource": {
      const t = value.trim();
      if (!(INTAKE_SOURCES as readonly string[]).includes(t)) throw new SettingError(M().intake.source);
      return t;
    }
    case "intakeTrackerQuery":
      if (value.length > 1000) throw new SettingError(M().intake.query);
      return value.trim();
    case "intakeTrackerDir":
    case "intakeFilePath": {
      const t = value.trim();
      if (t && !isAbsolutePath(t)) throw new SettingError(M().intake.absolute);
      return t;
    }
    case "intakePollMinutes": {
      const t = value.trim();
      if (!/^\d{1,4}$/.test(t) || Number(t) < 5 || Number(t) > 1440) throw new SettingError(M().intake.pollMinutes);
      return String(Number(t));
    }
    case "intakeRepoMap": {
      if (value.length > 20_000) throw new SettingError(M().intake.repoMapTooLong);
      const { errors } = parseRepoMap(value);
      if (errors.length > 0) throw new SettingError(M().intake.repoMap(errors.slice(0, 5).join(", ")));
      return value.replace(/\r\n/g, "\n").trim();
    }
    default: {
      // IPC 层已经用 isEditableSetting 拦过；这里再兜一次，免得以后新增的调用方绕过。
      const unknown: never = key;
      throw new SettingError(M().settingNotEditable(String(unknown)));
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

/** 记忆开关（memoryEnabled）：只有明确存成 "0" 才算关（默认开）。所有读这个开关的地方都用它。 */
export function memoryOn(s: Pick<SettingsRepo, "get">): boolean {
  return s.get("memoryEnabled") !== "0";
}

/** 换新阈值：0 或者最多 7 位的整数 token 数（大于任何模型的上下文）。 */
const REFRESH_THRESHOLD_RE = /^\d{1,7}$/;

/** 自动换新的阈值（refreshThresholdTokens，计划 16）：0 = 关；存的值不合法时用默认的 150000。 */
export function refreshThreshold(s: Pick<SettingsRepo, "get">): number {
  const t = s.get("refreshThresholdTokens").trim();
  return REFRESH_THRESHOLD_RE.test(t) ? Number(t) : Number(SETTING_DEFAULTS.refreshThresholdTokens);
}

/** 闲置关闭的分钟数：0 或者最多 5 位的整数（最长两个多月）。 */
const IDLE_CLOSE_RE = /^\d{1,5}$/;
/** 闲置关闭最短的时间：再短的话 session 刚回答完就被关了。 */
const MIN_IDLE_CLOSE_MINUTES = 10;

/** 闲置多少分钟自动关闭（idleCloseMinutes，BTL-190 第 8 点）：0 = 关；存的值不合法时用默认的 180。 */
export function idleCloseMinutes(s: Pick<SettingsRepo, "get">): number {
  const t = s.get("idleCloseMinutes").trim();
  const n = Number(t);
  return IDLE_CLOSE_RE.test(t) && (n === 0 || n >= MIN_IDLE_CLOSE_MINUTES) ? n : Number(SETTING_DEFAULTS.idleCloseMinutes);
}

/** 并行 session 的三项设置的取值范围（含两端）。 */
const SESSION_LIMITS = {
  sessionMemoryReserveMb: [0, 1_048_576],
  sessionMemoryEstimateMb: [64, 1_048_576],
  sessionMaxRunning: [0, 999],
} as const;

/**
 * 开新 session 前的内存准入（工作流 W）：保留线、预估占用（MB）和硬上限（0 = 不限）。
 * 保留线 null = 自动（默认，留空）。存的值不合法时用默认值。
 */
export function sessionAdmission(s: Pick<SettingsRepo, "get">): { reserveMb: number | null; sessionMb: number; maxRunning: number } {
  const read = (k: keyof typeof SESSION_LIMITS): number | null => {
    const t = s.get(k).trim();
    const n = Number(t);
    const [min, max] = SESSION_LIMITS[k];
    if (/^\d{1,7}$/.test(t) && n >= min && n <= max) return n;
    const d = SETTING_DEFAULTS[k];
    return d === "" ? null : Number(d);
  };
  return { reserveMb: read("sessionMemoryReserveMb"), sessionMb: read("sessionMemoryEstimateMb") ?? 1024, maxRunning: read("sessionMaxRunning") ?? 0 };
}

/** 备份间隔和导出提醒最多一年。 */
const MAX_CONFIG_DAYS = 365;
const configNumber = (s: Pick<SettingsRepo, "get">, key: "configBackupIntervalDays" | "configBackupKeep" | "configExportReminderDays", ok: (n: number) => boolean): number => {
  const t = s.get(key).trim();
  const n = Number(t);
  return /^\d{1,3}$/.test(t) && ok(n) ? n : Number(SETTING_DEFAULTS[key]);
};
/** 自动备份间隔（天）：0 = 关；存的值不合法时用默认（关）。 */
export const configBackupIntervalDays = (s: Pick<SettingsRepo, "get">) => configNumber(s, "configBackupIntervalDays", (n) => n <= MAX_CONFIG_DAYS);
/** 自动备份留几个：至少 1。 */
export const configBackupKeep = (s: Pick<SettingsRepo, "get">) => configNumber(s, "configBackupKeep", (n) => n >= 1);
/** 导出提醒（天）：0 = 不提醒。 */
export const configExportReminderDays = (s: Pick<SettingsRepo, "get">) => configNumber(s, "configExportReminderDays", (n) => n <= MAX_CONFIG_DAYS);

/** 开关读法：存成 "1" 才算开，其余（包括损坏的值）都按默认值。 */
function flagOn(
  s: Pick<SettingsRepo, "get">,
  key: "memoryMonitor" | "backgroundPriority" | "orphanCleanup" | "hibernateEnabled" | "hibernateEndWatchers" | "memoryPressureEnabled" | "sharedMcp",
): boolean {
  const v = s.get(key).trim();
  return v === "0" || v === "1" ? v === "1" : SETTING_DEFAULTS[key] === "1";
}

/** 内存采样（WS-M A）开着没有。 */
export const memoryMonitorOn = (s: Pick<SettingsRepo, "get">): boolean => flagOn(s, "memoryMonitor");
/** 后台优先级（WS-M E）开着没有。 */
export const backgroundPriorityOn = (s: Pick<SettingsRepo, "get">): boolean => flagOn(s, "backgroundPriority");
/** 孤儿进程清理（WS-M F）开着没有。 */
export const orphanCleanupOn = (s: Pick<SettingsRepo, "get">): boolean => flagOn(s, "orphanCleanup");

/** 休眠（WS-M B）开着没有。 */
export const hibernateOn = (s: Pick<SettingsRepo, "get">): boolean => flagOn(s, "hibernateEnabled");
/** 休眠时结束 watcher 和 dev server（WS-M I）。 */
export const hibernateEndWatchersOn = (s: Pick<SettingsRepo, "get">): boolean => flagOn(s, "hibernateEndWatchers");
/** 内存紧张时休眠（WS-M C）开着没有。 */
export const memoryPressureOn = (s: Pick<SettingsRepo, "get">): boolean => flagOn(s, "memoryPressureEnabled");
/** 共享 MCP（WS-M H）开着没有。 */
export const sharedMcpOn = (s: Pick<SettingsRepo, "get">): boolean => flagOn(s, "sharedMcp");

/** 休眠的分钟数：0 或者最多 5 位的整数。 */
const HIBERNATE_MINUTES_RE = /^\d{1,5}$/;
/** 休眠最短的等待：再短的话刚停下就被结束了。 */
const MIN_HIBERNATE_MINUTES = 5;
const MAX_PRESSURE_PERCENT = 50;

const HIBERNATE_MINUTE_KEYS = {
  you: "hibernateYouMinutes",
  ci: "hibernateCiMinutes",
  review: "hibernateReviewMinutes",
  idle: "hibernateIdleMinutes",
} as const;

/** 在 state 这种等待里停多少分钟后休眠（WS-M B）：0 = 不休眠；存的值不合法时用默认值。 */
export function hibernateMinutes(s: Pick<SettingsRepo, "get">, state: keyof typeof HIBERNATE_MINUTE_KEYS): number {
  const key = HIBERNATE_MINUTE_KEYS[state];
  const t = s.get(key).trim();
  const n = Number(t);
  return HIBERNATE_MINUTES_RE.test(t) && (n === 0 || n >= MIN_HIBERNATE_MINUTES) ? n : Number(SETTING_DEFAULTS[key]);
}

/** 内存紧张的线（memoryPressureFreePercent，WS-M C）：可用内存低于百分之几；不合法时用默认的 10。 */
export function memoryPressureFreePercent(s: Pick<SettingsRepo, "get">): number {
  const t = s.get("memoryPressureFreePercent").trim();
  const n = Number(t);
  return /^\d{1,2}$/.test(t) && n >= 1 && n <= MAX_PRESSURE_PERCENT ? n : Number(SETTING_DEFAULTS.memoryPressureFreePercent);
}

/** 内存阈值的 MB 数：0 或者最多 6 位的整数。 */
const MEMORY_MB_RE = /^\d{1,6}$/;
/** 按内存换新的最低阈值：再低的话刚开的 claude 就超了。 */
const MIN_REFRESH_MEMORY_MB = 256;

/** 按内存换新的阈值（refreshMemoryMb，WS-M G）：0 = 关（默认，工作流 R：什么都不配置时和 2.1.0 一样）；存的值不合法时用默认值。 */
export function refreshMemoryMb(s: Pick<SettingsRepo, "get">): number {
  const t = s.get("refreshMemoryMb").trim();
  const n = Number(t);
  return MEMORY_MB_RE.test(t) && (n === 0 || n >= MIN_REFRESH_MEMORY_MB) ? n : Number(SETTING_DEFAULTS.refreshMemoryMb);
}

/** Shipherd 总控每天巡检的时刻（shipherdPatrolTime，BTL-190 第 5 点）：关着或者存的值不合法时为 null（不猜一个时间）。 */
export function shipherdPatrolTime(s: Pick<SettingsRepo, "get">): { h: number; m: number } | null {
  return parseTime(s.get("shipherdPatrolTime"));
}

export function trackerTools(s: SettingsRepo): string[] {
  // 读取时再过滤一次：存储的值损坏或被改过，也不会把任意 flag / 工具带进 --allowedTools。
  return parseToolList(s.get("trackerTools")).filter((t) => TRACKER_TOOL_RE.test(t));
}

/** 审计的保留天数（auditRetentionDays，对外动作的审计用）：与 normalizeSetting 同一个范围，1–3650 的整数，否则回退 90。 */
export function auditRetentionDays(s: Pick<SettingsRepo, "get">): number {
  const t = s.get("auditRetentionDays").trim();
  const n = Number(t);
  return /^\d{1,4}$/.test(t) && n >= 1 && n <= 3650 ? n : 90;
}

const CHECKS_EDIT_RANGE = [1, 30] as const;
const CHECKS_PUSH_RANGE = [10, 3600] as const;

const BASELINE_GUIDE_RANGE = [200, 4000] as const;
const LEGACY_FILES_RANGE = [100, 500_000] as const;

/** 仓库现状和存量扫描的设置（工作流 E2）；存坏了的值回退到默认。 */
export function baselinesConfig(s: Pick<SettingsRepo, "get">): { infer: "auto" | "off"; autoRescan: boolean; guideChars: number; legacyMaxFiles: number } {
  const num = (k: "baselineGuideChars" | "legacyScanMaxFiles", [lo, hi]: readonly [number, number]) => {
    const n = Number(s.get(k));
    return Number.isInteger(n) && n >= lo && n <= hi ? n : Number(SETTING_DEFAULTS[k]);
  };
  return {
    infer: s.get("baselineInfer") === "off" ? "off" : "auto",
    autoRescan: s.get("baselineAutoRescan") !== "0",
    guideChars: num("baselineGuideChars", BASELINE_GUIDE_RANGE),
    legacyMaxFiles: num("legacyScanMaxFiles", LEGACY_FILES_RANGE),
  };
}

/** 确定性检查的设置（契约 4.5）；存坏了的值回退到默认。 */
export function checksConfig(s: Pick<SettingsRepo, "get">): { enabled: boolean; editTimeoutSec: number; pushTimeoutSec: number; ticketPattern: string } {
  const num = (k: "checksEditTimeoutSec" | "checksPushTimeoutSec", [lo, hi]: readonly [number, number]) => {
    const n = Number(s.get(k));
    return Number.isInteger(n) && n >= lo && n <= hi ? n : Number(SETTING_DEFAULTS[k]);
  };
  return {
    enabled: s.get("checksEnabled") !== "0",
    editTimeoutSec: num("checksEditTimeoutSec", CHECKS_EDIT_RANGE),
    pushTimeoutSec: num("checksPushTimeoutSec", CHECKS_PUSH_RANGE),
    ticketPattern: s.get("ticketPattern") || SETTING_DEFAULTS.ticketPattern,
  };
}
