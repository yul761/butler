import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "./db/database";

export function memDb(): Db {
  return openDatabase(":memory:");
}

/** realpath：macOS 的 /var 实际是 /private/var，git 返回的是真实路径。 */
export function tempDir(prefix = "butler-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
