import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HookStatus } from "../../shared/types";

export const HOOK_EVENTS = ["SessionStart", "Stop", "UserPromptSubmit", "SessionEnd"] as const;

type Json = Record<string, unknown>;
interface HookEntry {
  type?: string;
  command?: unknown;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}

export class SettingsParseError extends Error {}

/** 正斜杠 + 双引号：cmd、PowerShell、bash 都能执行，路径里有空格或中文也没问题。 */
export function hookCommand(hookBin: string, platform: NodeJS.Platform): string {
  const p = platform === "win32" ? hookBin.replace(/\\/g, "/") : hookBin;
  return `"${p.replace(/"/g, '\\"')}"`;
}

export function isButlerHook(command: unknown): boolean {
  return typeof command === "string" && /butler-hook(\.exe)?"?\s*$/.test(command);
}

function hookObject(settings: Json): Record<string, unknown> | null {
  const h = settings.hooks;
  return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>) : null;
}

function butlerCommands(settings: Json, event: string): unknown[] {
  const groups = hookObject(settings)?.[event];
  if (!Array.isArray(groups)) return [];
  return (groups as HookGroup[]).flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : [])).map((h) => h.command).filter(isButlerHook);
}

export function applyUninstall(settings: Json): Json {
  const next = structuredClone(settings);
  const hooks = hookObject(next);
  if (!hooks) return next;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = (groups as HookGroup[]).flatMap((g) => {
      if (!Array.isArray(g.hooks)) return [g];
      const remaining = g.hooks.filter((h) => !isButlerHook(h.command));
      if (remaining.length === g.hooks.length) return [g];
      return remaining.length ? [{ ...g, hooks: remaining }] : [];
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

export function applyInstall(settings: Json, command: string): Json {
  const next = applyUninstall(settings);
  const hooks = hookObject(next) ?? {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
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

export async function writeSettingsAtomic(file: string, data: Json): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const backup = `${file}.butler-backup`;
  if ((await exists(file)) && !(await exists(backup))) await copyFile(file, backup);
  const tmp = `${file}.butler-tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, file);
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
  await rename(tmp, dest);
}
