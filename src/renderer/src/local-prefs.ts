import { WIZARD_STEPS, type WizardStep } from "./wizard";

/**
 * 只属于这台机器、这个窗口的小记忆（localStorage）：向导停在哪一步、是不是跳过了向导。
 * 读写都可能失败（存储被禁用），失败时当作没有记录。
 */
const STEP_KEY = "butler.wizardStep";
const SKIPPED_KEY = "butler.wizardSkipped";

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 存不下就算了。
  }
}

export const savedWizardStep = (): WizardStep | null => {
  const v = get(STEP_KEY);
  return (WIZARD_STEPS as readonly string[]).includes(v ?? "") ? (v as WizardStep) : null;
};
export const saveWizardStep = (step: WizardStep | null) => set(STEP_KEY, step);
export const wizardSkipped = () => get(SKIPPED_KEY) === "1";
export const setWizardSkipped = (on: boolean) => set(SKIPPED_KEY, on ? "1" : null);

/**
 * 收起的区块（侧栏 feature 下的 ticket、feature 页的 ticket 表），按 id 记一个列表。
 * 每次都从存储里读了再改，两个地方同时用也不会互相覆盖。
 */
const COLLAPSED_KEY = "butler.collapsed";

function collapsedIds(): string[] {
  try {
    const v: unknown = JSON.parse(get(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const collapsedListeners = new Set<(id: string, on: boolean) => void>();

/** 收起状态变了就通知：已经挂载的区块跟着变，不用重新挂载。返回取消监听的函数。 */
export function onCollapsedChange(listener: (id: string, on: boolean) => void): () => void {
  collapsedListeners.add(listener);
  return () => void collapsedListeners.delete(listener);
}

/** 默认收起的区块（设置 › 高级的分组）反过来记：列表里存 `open:<id>` 表示用户展开过。 */
const openEntry = (id: string) => `open:${id}`;

export const isCollapsed = (id: string, defaultCollapsed = false): boolean =>
  defaultCollapsed ? !collapsedIds().includes(openEntry(id)) : collapsedIds().includes(id);
export function setCollapsed(id: string, on: boolean, defaultCollapsed = false): void {
  const entry = defaultCollapsed ? openEntry(id) : id;
  const present = defaultCollapsed ? !on : on;
  const rest = collapsedIds().filter((x) => x !== entry);
  const next = present ? [...rest, entry] : rest;
  set(COLLAPSED_KEY, next.length > 0 ? JSON.stringify(next) : null);
  for (const listener of collapsedListeners) listener(id, on);
}

/**
 * 页面上半部分的 tab（feature、Butler 总控页）：每个页面记着最近停在哪个 tab。
 * 没有记录时返回 null，用页面自己的默认 tab。
 */
const tabKey = (page: string) => `butler.tab:${page}`;
export const savedTab = (page: string): string | null => get(tabKey(page));
export const saveTab = (page: string, tab: string) => set(tabKey(page), tab);

/** 对话 tab 输入框「发给」上次选的是哪个：开发 session 还是只问不改（分叉讨论）。没有记录时默认只问不改。 */
const SEND_TARGET_KEY = "butler.sendTarget";
export const savedSendTarget = (): "dev" | "fork" => (get(SEND_TARGET_KEY) === "dev" ? "dev" : "fork");
export const saveSendTarget = (t: "dev" | "fork") => set(SEND_TARGET_KEY, t);

/** 对话 tab 的「并排显示终端」，按页面记（比如 `ticket:BTL-7`）。 */
const convSplitKey = (page: string) => `butler.convSplit:${page}`;
export const savedConvSplit = (page: string): boolean => get(convSplitKey(page)) === "1";
export const saveConvSplit = (page: string, on: boolean) => set(convSplitKey(page), on ? "1" : null);
