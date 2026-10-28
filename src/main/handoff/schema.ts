import { z } from "zod";
import { FeatureHandoffSchema, HandoffSchema, RefreshSchema, type Handoff } from "../../shared/handoff";

/** 这些约束只交给 zod 校验；传给 --json-schema 的版本里去掉，免得 claude 那一侧不支持而整个请求失败。 */
const DROPPED_KEYS = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format"]);

function strip(node: unknown, isPropertyMap = false): unknown {
  if (Array.isArray(node)) return node.map((n) => strip(n));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    // properties 里的键是字段名，不能当成约束去掉。
    if (!isPropertyMap && DROPPED_KEYS.has(k)) continue;
    out[k] = strip(v, !isPropertyMap && k === "properties");
  }
  return out;
}

export function toCliJsonSchema(schema: z.ZodType): string {
  return JSON.stringify(strip(z.toJSONSchema(schema, { target: "draft-7" })));
}

export const HANDOFF_JSON_SCHEMA = toCliJsonSchema(HandoffSchema);
export const REFRESH_JSON_SCHEMA = toCliJsonSchema(RefreshSchema);
export const FEATURE_HANDOFF_JSON_SCHEMA = toCliJsonSchema(FeatureHandoffSchema);

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string };

export function validate<T>(schema: z.ZodType<T>, value: unknown): Validated<T> {
  const r = schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: z.prettifyError(r.error) };
}

/** claude 的文本输出里找 JSON：整段就是 JSON，或者在代码块里（从最后一个往前试）。 */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // 继续找代码块。
  }
  const blocks = [...t.matchAll(/```[^\n]*\n([\s\S]*?)\n?```/g)].map((m) => m[1]);
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(blocks[i]);
    } catch {
      // 试下一个。
    }
  }
  return undefined;
}

/** 信息串必须正好是 butler-handoff，后面只能跟空白再接别的（```butler-handoffX 不算）。 */
const HANDOFF_BLOCK_RE = /```butler-handoff(?:[ \t][^\r\n]*)?\r?\n([\s\S]*?)\r?\n?```/g;

/** 最后一个非空的 ```butler-handoff 代码块的内容；没有就是 null。 */
export function extractHandoffBlock(text: string): string | null {
  const blocks = [...text.matchAll(HANDOFF_BLOCK_RE)].map((m) => m[1].trim()).filter(Boolean);
  return blocks.length ? blocks[blocks.length - 1] : null;
}

const JSON_BLOCK_RE = /```json(?:[ \t][^\r\n]*)?\r?\n([\s\S]*?)\r?\n?```/g;

/**
 * /handoff 那一轮里没有 butler-handoff 代码块时的退路：claude 有时把结果写成普通的 ```json 代码块。
 * 只收看起来就是 handoff 的那个（有 ticket 和 next_steps），取最后一个。
 */
export function extractJsonHandoffBlock(text: string): string | null {
  const blocks = [...text.matchAll(JSON_BLOCK_RE)].map((m) => m[1].trim()).filter((b) => {
    const v = parseJsonLoose(b) as Record<string, unknown> | null;
    return !!v && typeof v === "object" && typeof v.ticket === "string" && Array.isArray(v.next_steps);
  });
  return blocks.length ? blocks[blocks.length - 1] : null;
}

/** `--json-schema` 的结果在 structured_output；没有时退回解析 result 文本。 */
export function pickStructured(r: { structured: unknown; resultText: string }): unknown {
  return r.structured !== null && r.structured !== undefined ? r.structured : parseJsonLoose(r.resultText);
}

export function emptyHandoff(ticket: string): Handoff {
  return {
    ticket, status: "active", done_today: [], next_steps: [], blockers: [], prs: [], jira: null,
    followups: [], decisions: [], learnings: [], open_questions: [],
  };
}
