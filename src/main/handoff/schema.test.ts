import { describe, expect, it } from "vitest";
import { HandoffSchema, RefreshSchema } from "../../shared/handoff";
import {
  emptyHandoff, extractHandoffBlock, HANDOFF_JSON_SCHEMA, parseJsonLoose, pickStructured, REFRESH_JSON_SCHEMA, validate,
} from "./schema";
import {
  DEFAULT_HANDOFF_PROMPT, DEFAULT_REFRESH_PROMPT, HANDOFF_COMMAND_MARKER, HANDOFF_COMMAND_MD, HANDOFF_EXAMPLE, HANDOFF_EXAMPLE_VALUE,
} from "./templates";

describe("handoff schema", () => {
  it("accepts the documented example and an empty handoff", () => {
    expect(HandoffSchema.safeParse(JSON.parse(HANDOFF_EXAMPLE)).success).toBe(true);
    expect(HandoffSchema.safeParse(emptyHandoff("PROJ-1")).success).toBe(true);
  });

  it("reports missing and wrong fields with their path", () => {
    const bad: Record<string, unknown> = { ...HANDOFF_EXAMPLE_VALUE, status: "shipping" };
    delete bad.done_today;
    const r = validate(HandoffSchema, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("done_today");
      expect(r.errors).toContain("status");
    }
  });

  it("drops unknown keys instead of failing", () => {
    const r = validate(HandoffSchema, { ...HANDOFF_EXAMPLE_VALUE, extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).not.toHaveProperty("extra");
  });
});

describe("CLI JSON Schema", () => {
  it("describes every handoff field and leaves out constraints claude may not support", () => {
    const s = JSON.parse(HANDOFF_JSON_SCHEMA) as {
      type: string;
      required: string[];
      properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
    };
    expect(s.type).toBe("object");
    expect([...s.required].sort()).toEqual([
      "blockers", "decisions", "done_today", "followups", "jira", "learnings", "next_steps", "open_questions", "pr", "status", "ticket",
    ]);
    expect(Object.keys(s.properties.followups.items?.properties ?? {})).toContain("due_date");
    for (const key of ["$schema", "minimum", "maximum", "minLength", "pattern"]) expect(HANDOFF_JSON_SCHEMA).not.toContain(`"${key}"`);
  });

  it("refresh schema only asks for status, pr and jira", () => {
    expect((JSON.parse(REFRESH_JSON_SCHEMA) as { required: string[] }).required.sort()).toEqual(["jira", "pr", "status"]);
    expect(RefreshSchema.safeParse({ status: "in_review", pr: null, jira: null }).success).toBe(true);
  });
});

describe("loose parsing", () => {
  it("parses bare JSON, fenced JSON with prose around it, or gives up", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('好的，结果如下：\n```json\n{"a":2}\n```\n以上。')).toEqual({ a: 2 });
    expect(parseJsonLoose("没有 JSON")).toBeUndefined();
  });

  it("takes the last butler-handoff block", () => {
    const text = '示例：\n```butler-handoff\n{"n":1}\n```\n真正的：\n```butler-handoff\n{"n":2}\n```';
    expect(extractHandoffBlock(text)).toBe('{"n":2}');
    expect(extractHandoffBlock('```json\n{}\n```')).toBeNull();
  });

  it("prefers structured_output and falls back to the result text", () => {
    expect(pickStructured({ structured: { a: 1 }, resultText: "x" })).toEqual({ a: 1 });
    expect(pickStructured({ structured: null, resultText: '{"b":2}' })).toEqual({ b: 2 });
  });
});

describe("templates", () => {
  it("default prompts carry every placeholder the runner fills", () => {
    for (const p of ["{{ticket}}", "{{title}}", "{{branch}}", "{{tracker_tools}}", "{{previous_handoff}}", "{{open_followups}}", "{{schema}}", "{{example}}"]) {
      expect(DEFAULT_HANDOFF_PROMPT).toContain(p);
    }
    for (const p of ["{{ticket}}", "{{branch}}", "{{tracker_tools}}", "{{current_status}}", "{{schema}}"]) expect(DEFAULT_REFRESH_PROMPT).toContain(p);
  });

  it("the /handoff command asks for a butler-handoff block and passes arguments", () => {
    expect(HANDOFF_COMMAND_MD.startsWith("---\ndescription:")).toBe(true);
    expect(HANDOFF_COMMAND_MD).toContain(HANDOFF_COMMAND_MARKER);
    expect(HANDOFF_COMMAND_MD).toContain("```butler-handoff");
    expect(HANDOFF_COMMAND_MD).toContain("$ARGUMENTS");
  });
});
