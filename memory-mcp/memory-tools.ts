// 共享 MCP（WS-M H，设计文档 2026-11-17 §8）里的记忆 server：照 statecore-mcp 1.1.0 的工具层复刻，
// initialize、tools/list 和每个工具的结果都要和它一字不差（hub-contract.test.ts 拿真的 statecore-mcp 比）。
// 后端（StateCore 的嵌入式后端）由 hub-entry.ts 建好传进来，这里不 import statecore-mcp。

/** statecore-mcp 的 MemoryBackend 里这里用到的部分。 */
export interface MemoryBackendLike {
  remember(input: { text: string; consolidate?: boolean }): Promise<unknown>;
  recall(input: { query?: string; maxChars?: number }): Promise<unknown>;
  facts(): Promise<unknown>;
  pendingEvents?(): Promise<unknown>;
  why(input: { factId: string }): Promise<unknown>;
  forget(input: { factKey: string }): Promise<unknown>;
  handoff(input: { summary?: string; openQuestions?: string[]; nextSteps?: string[]; clear?: boolean }): Promise<unknown>;
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** 复刻的是这个版本；statecore-mcp 升级、工具层变了，契约测试会失败。 */
export const STATECORE_MCP_VERSION = "1.1.0";
/** MCP SDK（statecore-mcp 用的 1.x）认的协议版本：客户端要的在里面就用它，不在就回最新的。 */
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

export const MEMORY_INSTRUCTIONS = [
  "StateCore is this project's persistent memory across sessions.",
  "At the start of a session — and before relying on past context — call `recall` to load what is already known.",
  "Call `remember` proactively, without being asked, whenever one of these happens:",
  "- the user states a durable preference, or corrects you on one;",
  "- a decision is made (architecture, tooling, approach), including reversals of earlier decisions;",
  "- a non-obvious constraint, gotcha, or environment fact is discovered the hard way;",
  "- work ends in a state the next session must know about — for that, call `handoff` (summary, open questions, next steps) instead; `recall` hands it to the next session, so continue from a handoff when one appears.",
  "Store one self-contained fact per call, under 500 characters; pass consolidate: true for longer conversational context.",
  "When a fact changes, simply remember the corrected version — the engine detects revisions and keeps the old version on an auditable chain (`why` shows a fact's evidence and history; `forget` retires without deleting).",
  "Never store secrets, credentials, or tokens.",
].join("\n");

const SCHEMA = "http://json-schema.org/draft-07/schema#";
const EXECUTION = { taskSupport: "forbidden" };
const boundedStrings = { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, maxItems: 10 };

export const MEMORY_TOOLS = [
  {
    name: "remember",
    description: "Store a durable fact about this project or user. Use for preferences, decisions, constraints, and anything worth knowing next session. Deterministic and audit-tracked. Notes (the default path) are capped at 500 characters; pass consolidate=true for longer conversational context, accepted up to 2000 characters and distilled in the background.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 2000, description: "One self-contained fact, in plain language. Up to 500 characters, or 2000 with consolidate=true." },
        consolidate: { type: "boolean", description: "true for longer conversational context to be distilled into facts in the background; omit for a single fact." },
      },
      required: ["text"],
      additionalProperties: false,
      $schema: SCHEMA,
    },
    execution: EXECUTION,
  },
  {
    name: "recall",
    description: "Retrieve project memory relevant to a query, packed into a character budget. Read-only. Returns the active session handoff, the distilled digest, believed facts (with factIds for why), recent events, and a budget report of what was left out. Call at the start of a session or before relying on past context; use facts instead to see the whole memory unranked.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are about to work on, in natural language. Ranks facts and events by relevance; omit to rank by confidence and recency." },
        maxChars: { type: "integer", exclusiveMinimum: 0, maximum: 32000, description: "Character budget for the whole response (default 4000, max 32000). Items that do not fit are listed in the budget report, not silently dropped." },
      },
      additionalProperties: false,
      $schema: SCHEMA,
    },
    execution: EXECUTION,
  },
  {
    name: "facts",
    description: "List everything currently believed about this project, grouped, with each fact's factId (for why) and factKey (for forget), plus how many captured events are still waiting for distillation. Read-only, takes no arguments, and returns the full set unranked. Use to review or audit the memory; use recall instead to get only what is relevant to a task.",
    inputSchema: { type: "object", properties: {} },
    execution: EXECUTION,
  },
  {
    name: "why",
    description: "Explain why a fact is believed: its source evidence and the full version chain, including superseded and retired versions. Read-only. Use before trusting or correcting a fact that looks stale or surprising.",
    inputSchema: {
      type: "object",
      properties: { factId: { type: "string", minLength: 1, description: "The factId of a fact, as returned by facts or recall, or a handoffId from handoff." } },
      required: ["factId"],
      additionalProperties: false,
      $schema: SCHEMA,
    },
    execution: EXECUTION,
  },
  {
    name: "forget",
    description: "Suppress a fact that is wrong or no longer relevant, so recall and facts stop returning it. The record is retired, not deleted — why still shows it and the audit chain is preserved. To change a fact rather than drop it, call remember with the corrected version instead; the engine supersedes the old one.",
    inputSchema: {
      type: "object",
      properties: { factKey: { type: "string", minLength: 1, description: "The factKey of the fact to retire, as listed by facts (not its factId)." } },
      required: ["factKey"],
      additionalProperties: false,
      $schema: SCHEMA,
    },
    execution: EXECUTION,
  },
  {
    name: "handoff",
    description: "Record where this session stopped — a summary, open questions, and next steps — before ending or compacting. The next session (in this client or any other MCP client) receives it at the top of recall; each handoff supersedes the previous one on an auditable chain (why on the returned handoffId walks it). Pass clear=true to retire the active handoff instead.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", maxLength: 2000 }, openQuestions: boundedStrings, nextSteps: boundedStrings, clear: { type: "boolean" } },
      additionalProperties: false,
      $schema: SCHEMA,
    },
    execution: EXECUTION,
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError && { isError: true }) });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

class InputError extends Error {}

/** 按 inputSchema 检查参数（statecore-mcp 用 zod 做的那些），返回去掉了多余字段的参数；字符串按 zod 的 trim 处理 handoff 的。 */
function validate(tool: string, args: unknown): Record<string, unknown> {
  const a = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const bad = (what: string): never => {
    throw new InputError(`MCP error -32602: Input validation error: Invalid arguments for tool ${tool}: ${what}`);
  };
  const str = (key: string, o: { min?: number; max?: number; required?: boolean; trim?: boolean } = {}) => {
    let v = a[key];
    if (v === undefined) return o.required ? bad(`Required at ${key}`) : undefined;
    if (typeof v !== "string") return bad(`Expected string at ${key}`);
    if (o.trim) v = v.trim();
    const s = v as string;
    if (o.min !== undefined && s.length < o.min) bad(`String must contain at least ${o.min} character(s) at ${key}`);
    if (o.max !== undefined && s.length > o.max) bad(`String must contain at most ${o.max} character(s) at ${key}`);
    out[key] = s;
  };
  const bool = (key: string) => {
    const v = a[key];
    if (v === undefined) return;
    if (typeof v !== "boolean") bad(`Expected boolean at ${key}`);
    out[key] = v;
  };
  const list = (key: string) => {
    const v = a[key];
    if (v === undefined) return;
    if (!Array.isArray(v)) return bad(`Expected array at ${key}`);
    if (v.length > 10) bad(`Array must contain at most 10 element(s) at ${key}`);
    out[key] = v.map((x, i) => {
      if (typeof x !== "string") return bad(`Expected string at ${key}.${i}`);
      const t = x.trim();
      if (t.length < 1) bad(`String must contain at least 1 character(s) at ${key}.${i}`);
      if (t.length > 500) bad(`String must contain at most 500 character(s) at ${key}.${i}`);
      return t;
    });
  };
  switch (tool) {
    case "remember":
      str("text", { min: 1, max: 2000, required: true });
      bool("consolidate");
      break;
    case "recall": {
      str("query");
      const m = a.maxChars;
      if (m !== undefined) {
        if (typeof m !== "number" || !Number.isInteger(m)) bad("Expected integer at maxChars");
        if ((m as number) <= 0) bad("Number must be greater than 0 at maxChars");
        if ((m as number) > 32000) bad("Number must be less than or equal to 32000 at maxChars");
        out.maxChars = m;
      }
      break;
    }
    case "why":
      str("factId", { min: 1, required: true });
      break;
    case "forget":
      str("factKey", { min: 1, required: true });
      break;
    case "handoff":
      str("summary", { max: 2000, trim: true });
      list("openQuestions");
      list("nextSteps");
      bool("clear");
      break;
  }
  return out;
}

/** 一个作用域（STATECORE_SCOPE）的记忆 server。backend() 每次调用工具时取，hub 借此记下这个作用域最近用过。 */
export class MemoryServer {
  constructor(private readonly backend: () => Promise<MemoryBackendLike>) {}

  async handle(msg: Rpc): Promise<object | null> {
    const id = msg.id;
    if (id === undefined || id === null) return null;
    const reply = (result: unknown) => ({ result, jsonrpc: "2.0", id });
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        const protocolVersion = typeof asked === "string" && SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
        return reply({ protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "statecore", version: STATECORE_MCP_VERSION }, instructions: MEMORY_INSTRUCTIONS });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: MEMORY_TOOLS });
      case "tools/call":
        return reply(await this.call(msg.params?.name, msg.params?.arguments));
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  }

  private async call(name: unknown, args: unknown): Promise<object> {
    if (typeof name !== "string" || !MEMORY_TOOLS.some((t) => t.name === name)) return text(`MCP error -32602: Tool ${String(name)} not found`, true);
    try {
      const a = validate(name, args);
      const b = await this.backend();
      switch (name) {
        case "remember":
          if (!a.consolidate && (a.text as string).length > 500) {
            return text("notes are capped at 500 characters; pass consolidate: true for longer conversational content", true);
          }
          return json(await b.remember(a as { text: string; consolidate?: boolean }));
        case "recall":
          return json(await b.recall({ query: a.query as string | undefined, maxChars: (a.maxChars as number | undefined) ?? 4000 }));
        case "facts": {
          const groups = await b.facts();
          const pending = b.pendingEvents ? await b.pendingEvents() : null;
          return json(pending ? { groups, pending } : { groups });
        }
        case "why":
          return json(await b.why(a as { factId: string }));
        case "forget":
          return json(await b.forget(a as { factKey: string }));
        default: {
          const h = a as { summary?: string; openQuestions?: string[]; nextSteps?: string[]; clear?: boolean };
          if (!h.clear && !h.summary?.trim()) return text("summary is required unless clear is true", true);
          return json(await b.handoff(h));
        }
      }
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  }
}
