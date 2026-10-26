import { chmod, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HandoffCommandStatus } from "../../shared/types";
import { renameWithRetry } from "../util/fs-retry";
import { currentLang } from "../i18n";
import { handoffCommandBody, handoffCommandMd, parseHandoffCommand } from "./templates";

export function handoffCommandPath(commandsDir: string): string {
  return join(commandsDir, "handoff.md");
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * installed：和当前语言的当前版本一字不差；stale：hash 对得上的 Butler 旧版本或另一种语言的版本；
 * conflict：用户自己的命令，或 Butler 的文件被用户改过。
 */
export async function handoffCommandStatus(file: string): Promise<HandoffCommandStatus> {
  const text = await readOrNull(file);
  if (text === null) return "missing";
  const mine = parseHandoffCommand(text);
  if (!mine) return "conflict"; // 没有标记行、或 hash 对不上（用户改过）。
  return mine.body === handoffCommandBody(currentLang()) ? "installed" : "stale";
}

/** 写入或更新 Butler 自己的版本；用户自己的 handoff.md（或读不了的路径）不覆盖，返回 conflict。符号链接保留，原子写入，保留权限位。 */
export async function installHandoffCommand(file: string): Promise<HandoffCommandStatus> {
  let status: HandoffCommandStatus;
  try {
    status = await handoffCommandStatus(file);
  } catch {
    return "conflict";
  }
  if (status === "conflict" || status === "installed") return status;
  await mkdir(dirname(file), { recursive: true });
  const existed = status === "stale";
  const target = existed ? await realpath(file) : file;
  const mode = existed ? (await stat(target)).mode & 0o777 : undefined;
  const tmp = `${target}.butler-tmp`;
  await writeFile(tmp, handoffCommandMd(currentLang()), "utf8");
  if (mode !== undefined) await chmod(tmp, mode);
  await renameWithRetry(tmp, target);
  return "installed";
}

/** 只删除 Butler 写的文件。 */
export async function uninstallHandoffCommand(file: string): Promise<void> {
  let status: HandoffCommandStatus;
  try {
    status = await handoffCommandStatus(file);
  } catch {
    return;
  }
  if (status === "installed" || status === "stale") await unlink(file);
}
