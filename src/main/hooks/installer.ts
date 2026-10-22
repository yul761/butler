import { access, chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HookStatus } from "../../shared/types";
import { renameWithRetry } from "../util/fs-retry";

export const HOOK_EVENTS = ["SessionStart", "Stop", "UserPromptSubmit", "SessionEnd"] as const;

type Json = Record<string, unknown>;

export class SettingsParseError extends Error {}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 生成写入 settings.json 的 hook 命令：正斜杠 + 双引号。
 * 该形式可在 sh/bash（含 Git Bash）和 cmd 中执行，路径含空格或非 ASCII 字符也能正确解析。
 * PowerShell 不能直接执行带引号的裸路径，因此不依赖它；Windows 上的实际执行将在后续任务中验证。
 */
export function hookCommand(hookBin: string, platform: NodeJS.Platform): string {
  const p = platform === "win32" ? hookBin.replace(/\\/g, "/") : hookBin;
  return `"${p.replace(/"/g, '\\"')}"`;
}

/** 只识别 hookCommand 生成的精确形式：双引号包裹的路径，末段恰好是 butler-hook 或 butler-hook.exe。 */
export function isButlerHook(command: unknown): boolean {
  return typeof command === "string" && /^"[^"]*[/\\]butler-hook(\.exe)?"$/.test(command);
}

function hookObject(settings: Json): Record<string, unknown> | null {
  return isObj(settings.hooks) ? settings.hooks : null;
}

function butlerCommands(settings: Json, event: string): unknown[] {
  const groups = hookObject(settings)?.[event];
  if (!Array.isArray(groups)) return [];
  return groups
    .filter(isObj)
    .flatMap((g) => (Array.isArray(g.hooks) ? (g.hooks as unknown[]) : []))
    .filter(isObj)
    .map((h) => h.command)
    .filter(isButlerHook);
}

/** 只删除 Butler 自己的条目；非对象的 group/entry 原样保留；只有 Butler 实际删过的 event 键和 hooks 对象才会被清理。 */
export function applyUninstall(settings: Json): Json {
  const next = structuredClone(settings);
  const hooks = hookObject(next);
  if (!hooks) return next;
  let touched = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let removedHere = false;
    const kept: unknown[] = [];
    for (const g of groups as unknown[]) {
      if (!isObj(g) || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const entries = g.hooks as unknown[];
      const remaining = entries.filter((h) => !(isObj(h) && isButlerHook(h.command)));
      if (remaining.length === entries.length) {
        kept.push(g);
        continue;
      }
      removedHere = true;
      if (remaining.length) kept.push({ ...g, hooks: remaining });
    }
    if (!removedHere) continue;
    touched = true;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (touched && Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/** settings.hooks 或 hooks[event] 类型不对时抛 SettingsParseError，不做任何覆盖。 */
export function applyInstall(settings: Json, command: string): Json {
  const current = settings.hooks;
  if (current !== undefined && !isObj(current)) throw new SettingsParseError("settings.json 的 hooks 不是对象，Butler 不会修改它");
  for (const event of HOOK_EVENTS) {
    const cur = isObj(current) ? current[event] : undefined;
    if (cur !== undefined && !Array.isArray(cur)) {
      throw new SettingsParseError(`settings.json 的 hooks.${event} 不是数组，Butler 不会修改它`);
    }
  }
  const next = applyUninstall(settings);
  const hooks = hookObject(next) ?? {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...groups, { hooks: [{ type: "command", command, timeout: 10 }] }];
  }
  next.hooks = hooks;
  return next;
}

export function hookStatus(settings: Json, command: string): HookStatus {
  const perEvent = HOOK_EVENTS.map((e) => butlerCommands(settings, e));
  if (perEvent.every((cmds) => cmds.length === 1 && cmds[0] === command)) return "installed";
  if (perEvent.every((cmds) => cmds.length === 0)) return "missing";
  return perEvent.some((cmds) => cmds.some((c) => c !== command)) ? "stale" : "partial";
}

export async function readSettings(file: string): Promise<Json> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  text = text.replace(/^\uFEFF/, "");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Json;
  } catch {
    // 落到下面统一报错
  }
  throw new SettingsParseError(`${file} 不是合法的 JSON 对象，Butler 不会修改它`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子写入。若 file 是符号链接，写入真实文件（链接保留）；备份始终放在用户给出的路径旁边。
 * 已存在的文件保留原权限位。
 */
export async function writeSettingsAtomic(file: string, data: Json): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const backup = `${file}.butler-backup`;
  const existed = await exists(file);
  if (existed && !(await exists(backup))) await copyFile(file, backup);
  const target = existed ? await realpath(file) : file;
  const mode = existed ? (await stat(target)).mode & 0o777 : undefined;
  const tmp = `${target}.butler-tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  if (mode !== undefined) await chmod(tmp, mode);
  await renameWithRetry(tmp, target);
}

export async function installHooks(settingsFile: string, hookBin: string, platform: NodeJS.Platform): Promise<void> {
  const settings = await readSettings(settingsFile);
  await writeSettingsAtomic(settingsFile, applyInstall(settings, hookCommand(hookBin, platform)));
}

export async function uninstallHooks(settingsFile: string): Promise<void> {
  const settings = await readSettings(settingsFile);
  if (!settings.hooks) return;
  await writeSettingsAtomic(settingsFile, applyUninstall(settings));
}

export async function installHookBinary(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await copyFile(src, tmp);
  await chmod(tmp, 0o755);
  await renameWithRetry(tmp, dest);
}
