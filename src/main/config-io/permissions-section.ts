import { z } from "zod";
import type { PreviewRow } from "../../shared/config-io";
import { PermissionProfileRepo } from "../db/interrupts-repo";
import { isSafeRule } from "../permissions/classify";
import { fingerprint } from "./fingerprint";
import { emptyCounts, type ConfigSection, type ExportSelection } from "./registry";

/**
 * 权限档案（ws-j 设计 8，契约 4.3）：每个仓库确认过 / 不再提的规则。每条都过 isSafeRule：文件里有写操作的规则，这一条校验就不过。
 * 导入的「确认」先进 pending，要在本机设置页上再确认一次；不再提的照文件。待确认的不导出。webhook、路径都不在这里。
 */
export const PermissionItem = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    rule: z.string().min(1).max(500),
    status: z.enum(["confirmed", "dismissed"]),
  })
  .refine((v) => isSafeRule(v.rule), { message: "not a read-only rule" });
export type PermissionItem = z.infer<typeof PermissionItem>;

export const permissionFingerprint = (repo: string, rule: string): string => fingerprint({ t: "permission", repo, rule });

const label = (it: { repo: string; rule: string }) => `${it.rule} · ${it.repo}`;

function inScope(slug: string, sel: ExportSelection | { kind: "all" } | { kind: "repo"; slug: string } | { kind: "product"; slugs: string[] }): boolean {
  if (sel.kind === "all") return true;
  if (sel.kind === "repo") return sel.slug === slug;
  return sel.slugs.includes(slug);
}

/** 本机的决定（不含 pending），作为文件里的条目。 */
function localItems(repo: PermissionProfileRepo): PermissionItem[] {
  return repo
    .all()
    .filter((r): r is typeof r & { status: "confirmed" | "dismissed" } => r.status !== "pending" && isSafeRule(r.rule))
    .map((r) => ({ repo: r.slug, rule: r.rule, status: r.status }));
}

export const permissionsSection: ConfigSection<PermissionItem> = {
  id: "permissions",
  order: 70,
  content: "config",
  item: PermissionItem as unknown as z.ZodType<PermissionItem>,
  export(sel, { db }) {
    return localItems(new PermissionProfileRepo(db)).filter((it) => inScope(it.repo, sel));
  },
  diff(ctx) {
    const repo = new PermissionProfileRepo(ctx.db);
    const rows: PreviewRow[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items) {
      const fp = permissionFingerprint(it.repo, it.rule);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const cur = repo.get(it.repo, it.rule);
      if (!cur) {
        rows.push({ fingerprint: fp, label: label(it), status: "added", diffs: [], reasons: [], localId: null });
        continue;
      }
      // 本机还在等确认、文件里是确认：照旧 pending，不算变化。
      const same = cur.status === it.status || (cur.status === "pending" && it.status === "confirmed");
      rows.push({
        fingerprint: fp, label: label(it), status: same ? "unchanged" : "conflicting",
        diffs: same ? [] : [{ field: "status", local: cur.status, incoming: it.status }], reasons: same ? [] : ["status"], localId: null,
      });
    }
    // 文件范围里本机有、文件没有的：替换模式下删。
    const fs = ctx.fileScope;
    const sel = fs.kind === "all" ? { kind: "all" as const } : fs.kind === "repo" ? { kind: "repo" as const, slug: fs.slug } : null;
    if (sel) {
      for (const it of localItems(repo)) {
        const fp = permissionFingerprint(it.repo, it.rule);
        if (inScope(it.repo, sel) && !seen.has(fp)) rows.push({ fingerprint: fp, label: label(it), status: "removed", diffs: [], reasons: [], localId: null });
      }
    }
    return rows;
  },
  apply(ctx) {
    const counts = emptyCounts();
    const repo = new PermissionProfileRepo(ctx.db);
    // 和 diff 一样，同一条规则出现两次时以第一条为准。
    const incoming = new Map<string, PermissionItem>();
    for (const i of ctx.items) {
      const fp = permissionFingerprint(i.repo, i.rule);
      if (!incoming.has(fp)) incoming.set(fp, i);
    }
    const local = new Map(localItems(repo).map((i) => [permissionFingerprint(i.repo, i.rule), i]));
    for (const row of ctx.rows) {
      if ((row.status === "removed") !== (ctx.phase === "remove")) continue;
      if (row.status === "unchanged") {
        counts.kept++;
        continue;
      }
      if (row.status === "removed") {
        const it = local.get(row.fingerprint);
        if (ctx.mode !== "replace" || !it) continue;
        if (ctx.decide(row) === "local") {
          counts.kept++;
          continue;
        }
        repo.remove(it.repo, it.rule);
        counts.removed++;
        continue;
      }
      const it = incoming.get(row.fingerprint);
      if (!it || !isSafeRule(it.rule)) continue;
      if (ctx.decide(row) === "local") {
        counts.kept++;
        continue;
      }
      // 导入的确认不直接生效：pending，用户在本机确认后才写进 session。
      repo.set({ slug: it.repo, rule: it.rule, status: it.status === "confirmed" ? "pending" : "dismissed", source: "import", at: ctx.now });
      if (row.status === "added") counts.added++;
      else counts.updated++;
    }
    return counts;
  },
};
