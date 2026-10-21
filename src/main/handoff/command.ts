import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HandoffCommandStatus } from "../../shared/types";
import { HANDOFF_COMMAND_MARKER, HANDOFF_COMMAND_MD } from "./templates";

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

/** installed：和当前版本一字不差；stale：Butler 写的旧版本；conflict：用户自己的同名命令。 */
export async function handoffCommandStatus(file: string): Promise<HandoffCommandStatus> {
  const text = await readOrNull(file);
  if (text === null) return "missing";
  if (text === HANDOFF_COMMAND_MD) return "installed";
  return text.includes(HANDOFF_COMMAND_MARKER) ? "stale" : "conflict";
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
  await writeFile(tmp, HANDOFF_COMMAND_MD, "utf8");
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, target);
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
