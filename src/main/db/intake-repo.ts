import {
  INTAKE_RULES_VERSION, type IncomingTicket, type IntakeClassification, type IntakeDim, type IntakeSourceKind, type IntakeState, type IntakeWaitReason,
} from "../../shared/intake";
import type { Tier } from "../../shared/model-routing";
import type { Db } from "./database";

/** intake_items 的一行（工作流 N）。 */
export interface IntakeRecord {
  key: string;
  source: IntakeSourceKind;
  title: string;
  url: string | null;
  contentHash: string;
  payload: IncomingTicket;
  repoPath: string | null;
  repoSlug: string | null;
  state: IntakeState;
  waitReason: IntakeWaitReason | null;
  detail: string | null;
  classification: IntakeClassification;
  userDims: IntakeDim[];
  tier: Tier | null;
  model: string | null;
  allowParallel: boolean;
  forceStart: boolean;
  parentKey: string | null;
  layer: number | null;
  ticketKey: string | null;
  attempts: number;
  alertedAt: number | null;
  firstSeenAt: number;
  updatedAt: number;
  startedAt: number | null;
}

export type IntakePatch = Partial<Omit<IntakeRecord, "key" | "firstSeenAt">>;

interface Row {
  key: string; source: string; title: string; url: string | null; content_hash: string; payload: string; repo_path: string | null; repo_slug: string | null;
  state: string; wait_reason: string | null; detail: string | null; classification: string; user_dims: string; tier: string | null; model: string | null;
  allow_parallel: number; force_start: number; parent_key: string | null; layer: number | null; ticket_key: string | null; attempts: number;
  alerted_at: number | null; first_seen_at: number; updated_at: number; started_at: number | null;
}

const parse = <T>(t: string, fallback: T): T => {
  try {
    return JSON.parse(t) as T;
  } catch {
    return fallback;
  }
};

export const emptyClassification = (): IntakeClassification => ({
  size: null, risk: null, clarify: false, missing: [], questions: [], expectedPaths: [], reasons: [], source: "rules", rulesVersion: INTAKE_RULES_VERSION,
  confidence: null, model: null,
});

const emptyTicket = (key: string): IncomingTicket => ({
  key, title: "", description: "", type: null, labels: [], priority: null, url: null, storyPoints: null, components: [], subtasks: [], repo: null,
});

const num = (v: number | null): number | null => (v === null ? null : Number(v));

function toRecord(r: Row): IntakeRecord {
  return {
    key: r.key, source: r.source as IntakeSourceKind, title: r.title, url: r.url, contentHash: r.content_hash,
    payload: { ...emptyTicket(r.key), ...parse<Partial<IncomingTicket>>(r.payload, {}) },
    repoPath: r.repo_path, repoSlug: r.repo_slug, state: r.state as IntakeState, waitReason: r.wait_reason as IntakeWaitReason | null, detail: r.detail,
    classification: { ...emptyClassification(), ...parse<Partial<IntakeClassification>>(r.classification, {}) },
    userDims: parse<IntakeDim[]>(r.user_dims, []), tier: r.tier as Tier | null, model: r.model, allowParallel: r.allow_parallel === 1,
    forceStart: r.force_start === 1, parentKey: r.parent_key, layer: num(r.layer), ticketKey: r.ticket_key, attempts: Number(r.attempts),
    alertedAt: num(r.alerted_at), firstSeenAt: Number(r.first_seen_at), updatedAt: Number(r.updated_at), startedAt: num(r.started_at),
  };
}

/** 字段 → 列；JSON 列和布尔列在 toSql 里转。 */
const COLUMNS: Record<keyof IntakePatch, string> = {
  source: "source", title: "title", url: "url", contentHash: "content_hash", payload: "payload", repoPath: "repo_path", repoSlug: "repo_slug",
  state: "state", waitReason: "wait_reason", detail: "detail", classification: "classification", userDims: "user_dims", tier: "tier", model: "model",
  allowParallel: "allow_parallel", forceStart: "force_start", parentKey: "parent_key", layer: "layer", ticketKey: "ticket_key", attempts: "attempts",
  alertedAt: "alerted_at", updatedAt: "updated_at", startedAt: "started_at",
};

function toSql(k: keyof IntakePatch, v: unknown): string | number | null {
  if (k === "payload" || k === "classification" || k === "userDims") return JSON.stringify(v);
  if (k === "allowParallel" || k === "forceStart") return v ? 1 : 0;
  return (v ?? null) as string | number | null;
}

export interface IntakeOverride {
  id: number;
  itemKey: string;
  dim: IntakeDim;
  from: string | null;
  to: string;
  rulesVersion: number;
  classSource: string;
  at: number;
}

export class IntakeRepo {
  constructor(private readonly db: Db) {}

  get(key: string): IntakeRecord | null {
    const r = this.db.prepare(`SELECT * FROM intake_items WHERE key = ?`).get(key) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  /** 最近更新的在前。 */
  list(limit = 500): IntakeRecord[] {
    return (this.db.prepare(`SELECT * FROM intake_items ORDER BY updated_at DESC, key LIMIT ?`).all(limit) as unknown as Row[]).map(toRecord);
  }

  byState(states: readonly IntakeState[]): IntakeRecord[] {
    if (states.length === 0) return [];
    const q = states.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM intake_items WHERE state IN (${q}) ORDER BY first_seen_at, key`).all(...states) as unknown as Row[]).map(toRecord);
  }

  children(parentKey: string): IntakeRecord[] {
    return (this.db.prepare(`SELECT * FROM intake_items WHERE parent_key = ? ORDER BY layer, key`).all(parentKey) as unknown as Row[]).map(toRecord);
  }

  insert(r: IntakeRecord): void {
    const keys = Object.keys(COLUMNS) as (keyof IntakePatch)[];
    const cols = ["key", "first_seen_at", ...keys.map((k) => COLUMNS[k])];
    const vals = [r.key, r.firstSeenAt, ...keys.map((k) => toSql(k, r[k]))];
    this.db.prepare(`INSERT INTO intake_items (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  }

  update(key: string, patch: IntakePatch): void {
    const keys = (Object.keys(patch) as (keyof IntakePatch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${COLUMNS[k]} = ?`).join(", ");
    this.db.prepare(`UPDATE intake_items SET ${set} WHERE key = ?`).run(...keys.map((k) => toSql(k, patch[k])), key);
  }

  addOverride(o: Omit<IntakeOverride, "id">): void {
    this.db
      .prepare(`INSERT INTO intake_overrides (item_key, dim, from_value, to_value, rules_version, class_source, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(o.itemKey, o.dim, o.from, o.to, o.rulesVersion, o.classSource, o.at);
  }

  overrides(since: number): IntakeOverride[] {
    const rows = this.db.prepare(`SELECT * FROM intake_overrides WHERE at >= ? ORDER BY at, id`).all(since) as {
      id: number; item_key: string; dim: string; from_value: string | null; to_value: string; rules_version: number; class_source: string; at: number;
    }[];
    return rows.map((r) => ({
      id: Number(r.id), itemKey: r.item_key, dim: r.dim as IntakeDim, from: r.from_value, to: r.to_value, rulesVersion: Number(r.rules_version),
      classSource: r.class_source, at: Number(r.at),
    }));
  }
}
