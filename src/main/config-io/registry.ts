import type { z } from "zod";
import type { Db } from "../db/database";
import type { LessonsRepo } from "../db/lessons-repo";
import type { BatchContext } from "../batches/batch-recorder";
import type { AdmissionPolicyService } from "../lessons/admission-policies";
import type { ExportOptions, FileScope, ImportMode, PreviewRow, Resolution, SectionApplyCounts } from "../../shared/config-io";

/** 导出范围解析到本机：产品带上它的仓库。 */
export type ExportSelection =
  | { kind: "all" }
  | { kind: "product"; productId: number; name: string; slugs: string[] }
  | { kind: "repo"; slug: string };

/** 起步包导入时绑定到的归属（文件里用名字 / slug）。 */
export type StarterBinding = { repo: string } | { product: string };

export interface SectionEnv {
  db: Db;
  repo: LessonsRepo;
  policies: AdmissionPolicyService;
  now: number;
}

export interface ExportContext extends SectionEnv {
  options: ExportOptions;
  /** 起步包：不带归属、状态、hits、出处，只要已确认的规矩。 */
  starter: boolean;
}

export interface DiffContext<Item> extends SectionEnv {
  items: Item[];
  fileScope: FileScope;
  /** 文件里所有部分的内容（一个部分要看另一个部分时用，如产品的仓库列表）。 */
  doc: Record<string, unknown[]>;
  bound: StarterBinding | null;
}

export interface ApplyContext<Item> extends DiffContext<Item> {
  rows: PreviewRow[];
  mode: ImportMode;
  /**
   * 先 upsert（各部分按 order），再 remove（倒序）：删除放在所有新增之后，
   * 否则删掉的行（含级联删掉的）空出来的 rowid 会被新插入的行复用，过时的 localId 就指错了行。
   */
  phase: "upsert" | "remove";
  batch: BatchContext;
  /** 这一行用导入的还是本地的。 */
  decide(row: PreviewRow): Resolution;
}

/**
 * 导出文件的一个部分（契约 4.3）：自己的 schema、导出、和本地比对、应用。C 注册 products / lessons / policies；
 * E1 注册 checks（content: "checks"），A 注册 models，J 注册 permissions，E2 注册 baselines。
 */
export interface ConfigSection<Item = unknown> {
  id: string;
  /** 应用顺序：小的先（产品要在规矩和策略之前建好）。 */
  order: number;
  /** 「只导出规矩」包含 lessons；「只导出检查」包含 checks；config 只在「全部」里。一个部分可以属于几种（产品：规矩和检查都要）。 */
  content: SectionContent | readonly SectionContent[];
  /** 一个条目的 schema。 */
  item: z.ZodType<Item>;
  /** 起步包里有没有这个部分。 */
  inStarter?: boolean;
  export(sel: ExportSelection, ctx: ExportContext): Item[];
  /** 和本地比：added / changed / conflicting / unchanged，以及文件范围里本地有、文件没有的 removed（只在替换模式下删）。 */
  diff(ctx: DiffContext<Item>): PreviewRow[];
  apply(ctx: ApplyContext<Item>): SectionApplyCounts;
}

export type SectionContent = "lessons" | "checks" | "config";

const hasContent = (s: { content: SectionContent | readonly SectionContent[] }, c: SectionContent): boolean => (typeof s.content === "string" ? s.content === c : s.content.includes(c));

export class SectionRegistry {
  private readonly sections = new Map<string, ConfigSection<unknown>>();

  register<Item>(s: ConfigSection<Item>): void {
    if (this.sections.has(s.id)) throw new Error(`config section already registered: ${s.id}`);
    this.sections.set(s.id, s as unknown as ConfigSection<unknown>);
  }

  get(id: string): ConfigSection<unknown> | undefined {
    return this.sections.get(id);
  }

  list(): ConfigSection<unknown>[] {
    return [...this.sections.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  }

  /** 某种导出内容包含哪些部分。 */
  forContent(content: ExportOptions["content"], starter: boolean): ConfigSection<unknown>[] {
    return this.list().filter((s) => (starter ? s.inStarter === true : content === "all" ? true : hasContent(s, content)));
  }
}

export const emptyCounts = (): SectionApplyCounts => ({ added: 0, updated: 0, removed: 0, kept: 0, skipped: 0 });

export function countRows(rows: PreviewRow[]): Record<PreviewRow["status"], number> {
  const c = { added: 0, changed: 0, conflicting: 0, unchanged: 0, removed: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}
