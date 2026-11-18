// 存量扫描的纯函数部分（设计 §7）：选文件、读文件（跳过大文件和二进制）、一个文件一个文件地查。
import { inScope } from "../../shared/glob";
import { directRegexTest, evaluateBuiltin, type RegexTest } from "../../shared/check-rules";
import type { LegacyViolation } from "../../shared/baselines";

export const LEGACY_MAX_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE = 8 * 1024;

export interface LegacyCheck {
  type: string;
  params: Record<string, unknown>;
  globs: string[];
  excludeGlobs: string[];
}

/** 检查范围里的文件（列表已经是仓库相对、用 /）。 */
export function legacyFiles(files: string[], check: Pick<LegacyCheck, "globs" | "excludeGlobs">): string[] {
  return files.filter((f) => inScope(f, check.globs, check.excludeGlobs));
}

/** NUL 出现在前 8 KB 里就当二进制。 */
export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, BINARY_PROBE);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 一个文件的内容 → 违规（内置的三种；行按 \r?\n 切，所以 CRLF 文件的行号一样）。 */
export function legacyEvaluate(check: LegacyCheck, path: string, content: string, ticketPattern: string, test: RegexTest = directRegexTest()): LegacyViolation[] {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  return evaluateBuiltin(check, text, { path, ticketPattern, test }).map((v) => ({ file: path, line: v.line, snippet: (lines[v.line - 1] ?? v.text).trim().slice(0, 300) }));
}
