import { createHash } from "node:crypto";
import { canonical } from "../batches/batch-recorder";

/** 内容指纹：身份字段的规范 JSON 做 sha256，取前 16 个十六进制字符。从不用本地 id，所以两台机器上同一条东西指纹相同。 */
export function fingerprint(identity: unknown): string {
  return createHash("sha256").update(canonical(identity)).digest("hex").slice(0, 16);
}

/** 规矩正文的规范形式：去首尾空白、连续空白合一、小写。 */
export function normText(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** 规矩的归属在文件里的写法：仓库 slug 或产品名。 */
export type LessonOwner = { repo: string } | { product: string };

export function lessonFingerprint(text: string, owner: LessonOwner, globs: readonly string[]): string {
  return fingerprint({ t: "lesson", text: normText(text), owner, globs: [...new Set(globs.map((g) => g.trim()))].sort() });
}

export function productFingerprint(name: string): string {
  return fingerprint({ t: "product", name: name.trim() });
}

export type PolicyLayerRef = { kind: "global" } | { kind: "product"; name: string } | { kind: "repo"; slug: string };

export function policyFingerprint(layer: PolicyLayerRef): string {
  return fingerprint({ t: "policy", layer });
}
