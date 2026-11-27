/**
 * 设置页的布局（UI 重做 spec §5.3）：四个 tab，「高级」里按功能分组、默认收起。
 * 每一个可编辑的设置都在这里登记位置；漏了一个就编译不过。
 */
import type { EditableSettingKey } from "./settings";

/** about：版本和检查更新（BTL-253），BTL-254 的发送反馈也在这里。没有设置项放在那。 */
export const SETTINGS_TABS = ["basic", "features", "workflow", "advanced", "health", "about"] as const;
export type SettingsTabId = (typeof SETTINGS_TABS)[number];

export const ADVANCED_GROUPS = [
  "schedule", "sessions", "routing", "cost", "loop", "review", "stacks", "intake", "interrupts", "lessons", "external",
] as const;
export type AdvancedGroupId = (typeof ADVANCED_GROUPS)[number];

/** 路由里的 `section`：一个 tab，或者高级里的一个分组。旧值 health / routing / cost 仍然有效。 */
export type SettingsSection = SettingsTabId | AdvancedGroupId;

export function isSettingsTab(v: unknown): v is SettingsTabId {
  return typeof v === "string" && (SETTINGS_TABS as readonly string[]).includes(v);
}

export function isAdvancedGroup(v: unknown): v is AdvancedGroupId {
  return typeof v === "string" && (ADVANCED_GROUPS as readonly string[]).includes(v);
}

/** section 落到哪个 tab、要展开哪个分组。没有 section 时是「基本」。 */
export function sectionTarget(s: SettingsSection | undefined): { tab: SettingsTabId; group: AdvancedGroupId | null } {
  if (isSettingsTab(s)) return { tab: s, group: null };
  if (isAdvancedGroup(s)) return { tab: "advanced", group: s };
  return { tab: "basic", group: null };
}

export type Placement = { tab: "basic" } | { tab: "features" } | { tab: "advanced"; group: AdvancedGroupId } | { tab: "health" } | { tab: "elsewhere" };

const basic: Placement = { tab: "basic" };
const adv = (group: AdvancedGroupId): Placement => ({ tab: "advanced", group });
/** 在别的页面自己的区块里编辑（「复盘与规矩」页的检查、基线）。 */
const elsewhere: Placement = { tab: "elsewhere" };

export const SETTING_PLACEMENT: Record<EditableSettingKey, Placement> = {
  // 基本
  language: basic,
  claudePath: basic,
  branchTemplate: basic,
  ticketPattern: basic,
  memoryEnabled: basic,
  refreshThresholdTokens: basic,
  onboardingDone: basic,
  showOutsideSessions: basic,
  updateCheckEnabled: basic,
  autoResumeAfterRestart: basic,
  // 自动化（tab id 仍是 features）：全局档位
  automationLevel: { tab: "features" },
  // 高级 › 定时与 handoff
  nightlyTime: adv("schedule"),
  workingDays: adv("schedule"),
  shipherdPatrolTime: adv("schedule"),
  handoffPrompt: adv("schedule"),
  refreshPrompt: adv("schedule"),
  trackerTools: adv("schedule"),
  headlessProjectMcp: adv("schedule"),
  // 高级 › Session 与内存
  sessionMemoryReserveMb: adv("sessions"),
  sessionMemoryEstimateMb: adv("sessions"),
  sessionMaxRunning: adv("sessions"),
  idleCloseMinutes: adv("sessions"),
  memoryMonitor: adv("sessions"),
  backgroundPriority: adv("sessions"),
  orphanCleanup: adv("sessions"),
  refreshMemoryMb: adv("sessions"),
  hibernateEnabled: adv("sessions"),
  hibernateYouMinutes: adv("sessions"),
  hibernateCiMinutes: adv("sessions"),
  hibernateReviewMinutes: adv("sessions"),
  hibernateIdleMinutes: adv("sessions"),
  hibernateEndWatchers: adv("sessions"),
  memoryPressureEnabled: adv("sessions"),
  memoryPressureFreePercent: adv("sessions"),
  sharedMcp: adv("sessions"),
  // 高级 › 模型路由
  routingQuotas: adv("routing"),
  routingThresholds: adv("routing"),
  routingPeriodStartDay: adv("routing"),
  routingEffort: adv("routing"),
  routingMaxConcurrent: adv("routing"),
  routingAutoSwitch: adv("routing"),
  // 高级 › 花费与后台
  bgWindow: adv("cost"),
  bgHours: adv("cost"),
  bgIdleMinutes: adv("cost"),
  bgYield: adv("cost"),
  bgQuotaOrder: adv("cost"),
  bgPlentifulPercent: adv("cost"),
  bgKinds: adv("cost"),
  // 高级 › 预审和就绪
  preReviewEnabled: adv("review"),
  // UI 重做第 1 层：首页「请你 review」只看登记过的仓库还是全部
  reviewRequestScope: adv("review"),
  // 高级 › 自动接活
  intakeSource: adv("intake"),
  intakeTrackerQuery: adv("intake"),
  intakeTrackerDir: adv("intake"),
  intakeFilePath: adv("intake"),
  intakePollMinutes: adv("intake"),
  intakeRepoMap: adv("intake"),
  // 高级 › 打断与通知
  permissionProfiles: adv("interrupts"),
  interruptChoiceRule: adv("interrupts"),
  interruptChoiceDefaults: adv("interrupts"),
  interruptSelfServe: adv("interrupts"),
  notifyFormat: adv("interrupts"),
  notifyEvents: adv("interrupts"),
  notifyDetails: adv("interrupts"),
  notifyQuietHours: adv("interrupts"),
  // 高级 › 规矩与备份
  lessonsAutoAdmit: adv("lessons"),
  lessonsPrinciples: adv("lessons"),
  lessonsCoreGuide: adv("lessons"),
  configBackupIntervalDays: adv("lessons"),
  configBackupKeep: adv("lessons"),
  configExportReminderDays: adv("lessons"),
  // 高级 › 对外动作（auditRetentionDays：对外动作审计的保留天数，BTL-243 从「隐私」挪过来）
  auditRetentionDays: adv("external"),
  externalCommentReply: adv("external"),
  externalCommentResolve: adv("external"),
  externalPrDescriptionEdit: adv("external"),
  externalPrLabel: adv("external"),
  externalPrOpen: adv("external"),
  externalBranchPush: adv("external"),
  externalPrTitleEdit: adv("external"),
  externalForcePush: adv("external"),
  externalCiRerun: adv("external"),
  externalIssuePost: adv("external"),
  externalPushNotification: adv("external"),
  externalPrBriefPost: adv("external"),
  externalIntakeTrackerComment: adv("external"),
  externalIntakeTrackerStatus: adv("external"),
  externalPrReviewRequest: adv("external"),
  // 「复盘与规矩」页自己的区块
  checksEnabled: elsewhere,
  checksEditTimeoutSec: elsewhere,
  checksPushTimeoutSec: elsewhere,
  baselineInfer: elsewhere,
  baselineAutoRescan: elsewhere,
  baselineGuideChars: elsewhere,
  legacyScanMaxFiles: elsewhere,
};
