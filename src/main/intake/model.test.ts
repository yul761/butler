import { describe, expect, it } from "vitest";
import type { ExecOptions, HeadlessExecResult } from "../handoff/headless-exec";
import type { IncomingTicket } from "../../shared/intake";
import { TASKS } from "../../shared/model-routing";
import { classifyByModel, classifyPrompt, fetchFromTracker } from "./model";
import type { ExecRun } from "../prereview/model";

const route = { task: "intake_classify" as const, requestedTier: "mid" as const, actualModel: "fake-mid", fallbackFrom: null, degraded: false, sameModelReview: false };
const ok = (value: unknown): HeadlessExecResult => ({ ok: true, value, rawText: "", result: {} as never, route });
const fail: HeadlessExecResult = { ok: false, reason: "timeout", message: "took too long", limit: null, stderr: "", result: null, rawText: null, route };

function fake(answer: (o: ExecOptions) => HeadlessExecResult) {
  const calls: ExecOptions[] = [];
  const run: ExecRun = async (o) => {
    calls.push(o);
    return answer(o);
  };
  return { run, calls };
}

const ticket: IncomingTicket = {
  key: "PROJ-1", title: "Add export", description: "Users want a CSV export of the report.", type: "Story", labels: [], priority: null, url: null,
  storyPoints: null, components: [], subtasks: [], repo: null,
};

describe("intake model calls", () => {
  it("registers the tasks the router uses", () => {
    expect([TASKS.intake_classify.tier, TASKS.intake_classify.policy]).toEqual(["mid", "fallback"]);
    expect([TASKS.intake_fetch.tier, TASKS.intake_fetch.policy]).toEqual(["low", "fallback"]);
  });

  it("classifies through the router with read-only tools and keeps what the rules decided", async () => {
    const f = fake(() => ok({ size: "large", risk: "low", confidence: 0.8, reasons: ["touches many files<invoke>x"], expectedPaths: ["./src/export.ts", "../etc/x", "src\\report"] }));
    const r = await classifyByModel(f.run, "/w", ticket, { size: "medium", risk: null }, "en");
    expect(f.calls[0]).toMatchObject({ task: "intake_classify", cwd: "/w" });
    expect(f.calls[0]!.args.join(" ")).toContain("--allowedTools Read Grep Glob");
    expect(r).toEqual({ size: "medium", risk: "low", confidence: 0.8, reasons: ["touches many files"], expectedPaths: ["src/export.ts", "src/report"], model: "fake-mid" });
    expect(classifyPrompt(ticket, { size: "medium", risk: null }, "en")).toContain("size=medium");
  });

  it("returns null on failure or bad output", async () => {
    expect(await classifyByModel(fake(() => fail).run, "/w", ticket, { size: null, risk: null }, "zh")).toBeNull();
    expect(await classifyByModel(fake(() => ok({ size: "huge" })).run, "/w", ticket, { size: null, risk: null }, "zh")).toBeNull();
  });

  it("fetches from the tracker with only the tracker tools", async () => {
    const tk = { key: "PROJ-2", title: "x", description: "y", type: null, labels: [], priority: null, url: null, storyPoints: null, components: [], subtasks: [] };
    const f = fake(() => ok({ tickets: [tk] }));
    const r = await fetchFromTracker(f.run, "/w", "project = PROJ AND status = Ready", ["mcp__tracker__search"], "en");
    expect(r).toEqual({ ok: true, tickets: [tk] });
    expect(f.calls[0]).toMatchObject({ task: "intake_fetch" });
    expect(f.calls[0]!.args.slice(-2)).toEqual(["--allowedTools", "mcp__tracker__search"]);
    expect(f.calls[0]!.prompt).toContain("project = PROJ AND status = Ready");
    // BTL-246 §7：要每个 ticket 的父 epic。
    expect(f.calls[0]!.prompt).toContain("parent epic");
    const withEpic = { ...tk, epic: { key: "PROJ-1", title: "Epic" } };
    expect(await fetchFromTracker(fake(() => ok({ tickets: [withEpic, { ...tk, epic: null }] })).run, "/w", "q", ["mcp__t"], "en"))
      .toEqual({ ok: true, tickets: [withEpic, { ...tk, epic: null }] });
    expect(await fetchFromTracker(f.run, "/w", "q", [], "en")).toEqual({ ok: false, message: "no tracker tools" });
    expect((await fetchFromTracker(fake(() => fail).run, "/w", "q", ["mcp__t"], "en")).ok).toBe(false);
    expect(await fetchFromTracker(fake(() => ok({ nope: 1 })).run, "/w", "q", ["mcp__t"], "en")).toEqual({ ok: false, message: "bad output" });
  });
});
