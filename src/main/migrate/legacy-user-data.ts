// BTL-260：Electron 的 userData 目录按 package.json 的 name 命名，改名后从 <appData>/butler 变成 <appData>/shipherd。
// 这里的 butler 是旧目录名，必须认得才能接着用。TODO(5.0)：保留一个大版本后再考虑搬目录、删掉这段。
import { join } from "node:path";

export const LEGACY_USER_DATA_NAME = "butler";

/**
 * 老用户继续用旧的 userData 目录（不搬文件）：
 * - Windows 上 safeStorage 的密钥（DPAPI 加密）存在 userData 的 "Local State" 里，换目录就解不开已保存的 webhook 地址；
 * - 单实例锁也在 userData 里：旧 Butler 和新 Shipherd 共用一把锁，不会同时跑、同时改 ~/.shipherd。
 * 新目录里已经有 "Local State"（用过新目录了）就用新目录；旧目录不存在（新用户）也用新目录（返回 null = 不改）。
 * macOS 的 safeStorage 密钥在钥匙串里按应用名存，换名后照样读不到，webhook 会显示「需要重新填写」（webhook-store）。
 */
export function legacyUserDataDir(appData: string, exists: (p: string) => boolean): string | null {
  const current = join(appData, "shipherd");
  if (exists(join(current, "Local State"))) return null;
  const legacy = join(appData, LEGACY_USER_DATA_NAME);
  return exists(legacy) ? legacy : null;
}
