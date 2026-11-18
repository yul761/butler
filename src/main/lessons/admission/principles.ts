import type { Lesson } from "../../../shared/lessons";
import type { BatchRecorder } from "../../batches/batch-recorder";
import type { Db } from "../../db/database";
import type { LessonsRepo } from "../../db/lessons-repo";
import { OPEN_GATE, runPrinciples, type StepCtx } from "./model-steps";
import type { AdmissionPipeline } from "./pipeline";

/**
 * 原则（addendum 第 10 节）：每一层（一个仓库、一个产品）已确认的规矩交给 lesson_cluster 的原则模式，
 * 背后是同一条原则的至少 3 条归成一个原则。结果是一个能撤销的批次（原则行新建、改写、删除，规矩的 principle_id）。
 * 一层的调用失败时这一层保持原样。
 */

type Layer = { kind: "repo"; slug: string } | { kind: "product"; productId: number };

export interface PrinciplesDeps {
  db: Db;
  repo: LessonsRepo;
  recorder: BatchRecorder;
  pipeline: Pick<AdmissionPipeline, "rawStep">;
  ctx: () => StepCtx;
  now: () => number;
  log?: (msg: string, err?: unknown) => void;
}

interface PrincipleRow { id: number; text: string; why: string }

export interface RegroupOutcome {
  batchId: number | null;
  principles: number;
  lessons: number;
  /** 调用失败、保持原样的层数。 */
  failed: number;
}

const layerKey = (l: Layer) => (l.kind === "repo" ? `repo:${l.slug}` : `product:${l.productId}`);

export class PrinciplesService {
  private running: Promise<RegroupOutcome> | null = null;

  constructor(private readonly d: PrinciplesDeps) {}

  /** 重新分组所有层（定时任务和规矩页的按钮）；已经在跑就等那一次。 */
  regroup(): Promise<RegroupOutcome> {
    if (!this.running) this.running = this.regroupAll().finally(() => (this.running = null));
    return this.running;
  }

  private layers(): Layer[] {
    return [...this.d.repo.repos().map((r): Layer => ({ kind: "repo", slug: r.slug })), ...this.d.repo.products().map((p): Layer => ({ kind: "product", productId: p.id }))];
  }

  private confirmedIn(l: Layer): Lesson[] {
    return this.d.repo
      .lessons({ status: ["confirmed"], scope: l })
      .filter((x) => x.mergedInto === null)
      .sort((a, b) => a.id - b.id);
  }

  private async regroupAll(): Promise<RegroupOutcome> {
    const ctx = { ...this.d.ctx(), gate: OPEN_GATE };
    const plans: { layer: Layer; lessons: Lesson[]; groups: { ids: number[]; text: string; why: string }[] }[] = [];
    let failed = 0;
    for (const layer of this.layers()) {
      const lessons = this.confirmedIn(layer);
      if (lessons.length < 3) {
        plans.push({ layer, lessons, groups: [] });
        continue;
      }
      const answer = await runPrinciples(ctx, layerKey(layer), lessons.map((l) => this.d.pipeline.rawStep(l)));
      if (answer === null) {
        failed++;
        continue;
      }
      plans.push({ layer, lessons, groups: answer });
    }
    return this.apply(plans, failed);
  }

  private apply(plans: { layer: Layer; lessons: Lesson[]; groups: { ids: number[]; text: string; why: string }[] }[], failed: number): RegroupOutcome {
    const now = this.d.now();
    const db = this.d.db;
    let principles = 0;
    let lessons = 0;
    let changes = 0;
    const { outcome } = this.d.recorder.run({ kind: "principles_regroup", origin: "auto", entity: "principle", scope: { layers: plans.length }, now }, (ctx) => {
      for (const { layer, lessons: ls, groups } of plans) {
        const existing = this.rowsOf(layer);
        const membersOf = new Map(existing.map((p) => [p.id, ls.filter((l) => l.principleId === p.id).map((l) => l.id).sort((a, b) => a - b).join(",")]));
        const want = new Map<number, number | null>(ls.map((l) => [l.id, null]));
        const kept = new Set<number>();
        for (const g of groups) {
          const key = [...g.ids].sort((a, b) => a - b).join(",");
          // 成员完全一样的原则留着原来的行（id 不变），只改写正文。
          const same = existing.find((p) => !kept.has(p.id) && membersOf.get(p.id) === key);
          let id: number;
          if (same) {
            id = same.id;
            kept.add(id);
            if (same.text !== g.text || same.why !== g.why) {
              ctx.track("principle", id);
              changes++;
              db.prepare(`UPDATE lesson_principles SET text = ?, why = ?, updated_at = ? WHERE id = ?`).run(g.text, g.why, now, id);
            }
          } else {
            id = Number(
              db
                .prepare(`INSERT INTO lesson_principles (scope_kind, repo_slug, product_id, text, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(layer.kind, layer.kind === "repo" ? layer.slug : null, layer.kind === "product" ? layer.productId : null, g.text, g.why, now, now).lastInsertRowid,
            );
            ctx.created("principle", id);
            changes++;
            kept.add(id);
          }
          principles++;
          for (const lid of g.ids) want.set(lid, id);
        }
        for (const l of ls) {
          const to = want.get(l.id) ?? null;
          if (l.principleId === to) continue;
          ctx.track("lesson_principle", l.id);
          this.d.repo.setPrinciple(l.id, to);
          lessons++;
          changes++;
        }
        // 不再用到的原则删掉（先把还指着它的规矩改掉：别的层的规矩不会指着它）。
        for (const p of existing) {
          if (kept.has(p.id)) continue;
          for (const r of db.prepare(`SELECT id FROM lessons WHERE principle_id = ?`).all(p.id) as { id: number }[]) {
            ctx.track("lesson_principle", Number(r.id));
            this.d.repo.setPrinciple(Number(r.id), null);
          }
          ctx.track("principle", p.id);
          changes++;
          db.prepare(`DELETE FROM lesson_principles WHERE id = ?`).run(p.id);
        }
      }
      if (!changes) ctx.skip();
    });
    return { batchId: outcome.batchId, principles, lessons, failed };
  }

  private rowsOf(l: Layer): PrincipleRow[] {
    const rows =
      l.kind === "repo"
        ? db(this.d.db, `SELECT id, text, why FROM lesson_principles WHERE scope_kind = 'repo' AND repo_slug = ? ORDER BY id`, l.slug)
        : db(this.d.db, `SELECT id, text, why FROM lesson_principles WHERE scope_kind = 'product' AND product_id = ? ORDER BY id`, l.productId);
    return rows.map((r) => ({ id: Number(r.id), text: String(r.text), why: String(r.why) }));
  }
}

const db = (d: Db, sql: string, arg: string | number) => d.prepare(sql).all(arg) as { id: number; text: string; why: string }[];
