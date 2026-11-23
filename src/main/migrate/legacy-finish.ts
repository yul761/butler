// BTL-260：~/.butler → ~/.shipherd 迁移之后的收尾。TODO(5.0)：和 legacy-home.ts 一起删。
import type { ShipherdPaths } from "../paths";
import {
  copyClaudeJsonProjects,
  moveClaudeProjects,
  readMigrationMarker,
  renameWorkspace,
  rewriteForkPaths,
  rewriteSessionCwds,
  rewriteTranscriptCursors,
  type LegacyHomeResult,
  type PathColumnDb,
} from "./legacy-home";

/**
 * 记下迁移结果；新目录里有迁移标记时（这次刚搬的，或者以前搬过、上次收尾没做完）做一遍幂等的收尾：
 * 总控工作区改名，Claude 的 projects 目录（连同读对话记录的游标）、~/.claude.json 的项目条目、
 * 数据库里的 session 工作目录和分叉讨论的路径，都从旧路径换到新路径。
 * 每一步单独兜住错误：一步失败不影响启动，下次启动再做。
 */
export async function finishLegacyHome(
  result: LegacyHomeResult,
  paths: Pick<ShipherdPaths, "home" | "claudeProjects" | "claudeJson">,
  db: PathColumnDb,
  log: (msg: string) => void,
): Promise<void> {
  if (result.kind === "moved") log(`legacy data dir moved: ${result.marker.from} -> ${result.marker.to} (${result.marker.how}, old location: ${result.leftover})`);
  if (result.kind === "moved" && result.strayKept) log(`legacy data dir: ${result.marker.to} was in the way and has been set aside; what could not be merged is still in ${result.strayKept}`);
  if (result.kind === "skipped" && result.reason === "already" && result.repaired) log(`legacy data dir: old location restored (${result.repaired})`);
  if (result.kind === "failed") log(`legacy data dir migration failed, using ${result.legacy} for now and trying again at the next start: ${result.error}`);
  const marker = readMigrationMarker(paths.home);
  if (!marker || marker.to !== paths.home) return;
  const step = async (name: string, f: () => number | Promise<number>) => {
    try {
      const n = await f();
      if (n > 0) log(`legacy data dir: ${name} ${n}`);
    } catch (e) {
      log(`legacy data dir: ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await step("coordinator workspace renamed", () => (renameWorkspace(paths.home) ? 1 : 0));
  await step("session cwds rewritten", () => rewriteSessionCwds(db, marker));
  await step("fork discussion paths rewritten", () => rewriteForkPaths(db, marker));
  await step("claude project dirs moved", () => moveClaudeProjects(paths.claudeProjects, marker));
  await step("transcript cursors rewritten", () => rewriteTranscriptCursors(db, paths.claudeProjects, marker));
  await step("claude.json project entries copied", () => copyClaudeJsonProjects(paths.claudeJson, marker));
}
