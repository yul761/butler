import { EMPTY_BRIEF_CONTENT, type Brief, type BriefContent, type BriefNotices, type BriefKind, type NarrativeStatus } from "../../shared/brief";
import type { Db } from "./database";

interface BriefRow {
  id: number;
  kind: string;
  date: string;
  created_at: number;
  items: string;
  narrative: string | null;
  narrative_status: string;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function parseContent(text: string): BriefContent {
  try {
    const v = JSON.parse(text) as Partial<BriefContent> & { notices?: Partial<BriefNotices> };
    return {
      items: v.items ?? [],
      previousDay: v.previousDay ?? null,
      evening: v.evening ?? [],
      // 旧的或不完整的行：缺哪个列表就补成空的，界面不会拿到 undefined。
      notices: { degraded: list(v.notices?.degraded), trackerUnavailable: list(v.notices?.trackerUnavailable) },
    };
  } catch {
    return structuredClone(EMPTY_BRIEF_CONTENT);
  }
}

function toBrief(r: BriefRow): Brief {
  return {
    id: r.id,
    kind: r.kind as BriefKind,
    date: r.date,
    createdAt: r.created_at,
    ...parseContent(r.items),
    narrative: r.narrative,
    narrativeStatus: r.narrative_status as NarrativeStatus,
  };
}

export interface NewBrief {
  kind: BriefKind;
  date: string;
  createdAt: number;
  content: BriefContent;
  narrative: string | null;
  narrativeStatus: NarrativeStatus;
}

export class BriefsRepo {
  constructor(private readonly db: Db) {}

  insert(b: NewBrief): Brief {
    const r = this.db
      .prepare(`INSERT INTO briefs (kind, date, created_at, items, narrative, narrative_status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(b.kind, b.date, b.createdAt, JSON.stringify(b.content), b.narrative, b.narrativeStatus);
    return { id: Number(r.lastInsertRowid), kind: b.kind, date: b.date, createdAt: b.createdAt, ...b.content, narrative: b.narrative, narrativeStatus: b.narrativeStatus };
  }

  /** 早间简报入库之后，把“今日重点”写回同一行。 */
  setNarrative(id: number, narrative: string | null, status: NarrativeStatus): void {
    this.db.prepare(`UPDATE briefs SET narrative = ?, narrative_status = ? WHERE id = ?`).run(narrative, status, id);
  }

  latest(kind: BriefKind): Brief | null {
    const row = this.db.prepare(`SELECT * FROM briefs WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(kind) as BriefRow | undefined;
    return row ? toBrief(row) : null;
  }
}
