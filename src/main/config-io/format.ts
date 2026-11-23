import { z } from "zod";
import type { ExportOptions, FileScope } from "../../shared/config-io";

export const CONFIG_FORMAT = "shipherd-config";
/** 文件格式版本：结构有不兼容的变化时加一，并在 FORMAT_MIGRATIONS 里补一个从上一版升上来的函数。 */
export const CURRENT_FORMAT_VERSION = 1;
/** 导入文件的大小上限。 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export interface ConfigDoc {
  format: typeof CONFIG_FORMAT;
  formatVersion: number;
  exportedAt: number;
  shipherdVersion: string;
  scope: FileScope;
  options: ExportOptions;
  sections: Record<string, unknown[]>;
}

export type ConfigFormatReason = "not_json" | "not_shipherd" | "too_new" | "bad_section" | "too_large";

export class ConfigFormatError extends Error {
  constructor(readonly reason: ConfigFormatReason, readonly section?: string, detail?: string) {
    super(`${reason}${section ? ` (${section})` : ""}${detail ? `: ${detail}` : ""}`);
  }
}

/** 从第 v 版升到 v + 1 的函数（下标 = v）。第 1 版是第一版，还没有。 */
export const FORMAT_MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {};

const NAME = z.string().trim().min(1).max(200);
const SLUG = z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(300);
export const FileScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("product"), name: NAME }),
  z.object({ kind: z.literal("repo"), slug: SLUG }),
  z.object({ kind: z.literal("starter"), name: NAME }),
]);
const HeaderSchema = z.object({
  format: z.literal(CONFIG_FORMAT),
  formatVersion: z.number().int().min(1),
  exportedAt: z.number().int().nonnegative(),
  shipherdVersion: z.string().max(50),
  scope: FileScopeSchema,
  options: z.object({ content: z.enum(["all", "lessons", "checks"]), includeSourceUrls: z.boolean(), includeBaselines: z.boolean().optional() }),
  sections: z.record(z.string().max(100), z.array(z.unknown())),
});

/** 升到当前版本：比当前新的拒绝（「由更新的 Shipherd 导出，请先升级」）。 */
export function migrateDoc(raw: Record<string, unknown>, migrations = FORMAT_MIGRATIONS, current = CURRENT_FORMAT_VERSION): Record<string, unknown> {
  let doc = raw;
  let v = typeof doc.formatVersion === "number" ? doc.formatVersion : NaN;
  if (!Number.isInteger(v) || v < 1) throw new ConfigFormatError("not_shipherd");
  if (v > current) throw new ConfigFormatError("too_new");
  while (v < current) {
    const m = migrations[v];
    if (!m) throw new ConfigFormatError("not_shipherd", undefined, `no migration from ${v}`);
    doc = { ...m(doc), formatVersion: v + 1 };
    v++;
  }
  return doc;
}

/**
 * 改名前（BTL-260）Butler 导出的文件、以及 <数据目录>/backups 里的自动备份：format 是 butler-config，
 * 版本字段叫 butlerVersion，仓库现状里每条检查的 butlerStage 也改了名。换成新名字再按新格式解析。
 * 旧文件一直会在，这段不能删。
 */
export const LEGACY_CONFIG_FORMAT = "butler-config";
function fromLegacyName(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.format !== LEGACY_CONFIG_FORMAT) return raw;
  const { butlerVersion, ...rest } = raw;
  const renameStage = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(renameStage);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k === "butlerStage" ? "shipherdStage" : k] = renameStage(x);
    return out;
  };
  return { ...rest, format: CONFIG_FORMAT, shipherdVersion: rest.shipherdVersion ?? butlerVersion, sections: renameStage(rest.sections) };
}

/** 解析一个导出文件：不是 JSON、不是 Shipherd 的、版本太新都拒绝；各部分的内容由各自的 schema 再查。 */
export function parseDoc(text: string, migrations = FORMAT_MIGRATIONS, current = CURRENT_FORMAT_VERSION): ConfigDoc {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) throw new ConfigFormatError("too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new ConfigFormatError("not_json");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigFormatError("not_shipherd");
  const doc = fromLegacyName(raw as Record<string, unknown>);
  if (doc.format !== CONFIG_FORMAT) throw new ConfigFormatError("not_shipherd");
  const migrated = migrateDoc(doc, migrations, current);
  const p = HeaderSchema.safeParse(migrated);
  if (!p.success) throw new ConfigFormatError("not_shipherd", undefined, p.error.issues[0]?.message);
  return p.data as ConfigDoc;
}

export function serializeDoc(doc: ConfigDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 文件名里的时间：不含冒号（Windows 不允许）。 */
export function fileStamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}
