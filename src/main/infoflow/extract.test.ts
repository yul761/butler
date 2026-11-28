import { afterEach, describe, expect, it } from "vitest";
import type { HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { setLang } from "../i18n";
import { FLOW_MAX_ITEMS, FLOW_TEXT_LIMIT } from "../../shared/infoflow";
import { extractPrompt, extractTurn, parseExtraction, type ExtractContext } from "./extract";

function deps(out: HeadlessOutcome | (() => never), seen: HeadlessRequest[] = []): HeadlessExecDeps {
  return {
    run: async (req) => {
      seen.push(req);
      if (typeof out === "function") out();
      return out as HeadlessOutcome;
    },
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/bin" }),
    baseEnv: {},
    sessions: { recordHeadless: () => undefined } as unknown as HeadlessExecDeps["sessions"],
    now: () => 0,
    newRunId: () => "r",
  };
}
const usage = { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 };
const ok = (structured: unknown, resultText = ""): HeadlessOutcome => ({
  ok: true,
  result: { sessionId: null, isError: false, subtype: null, resultText, structured, permissionDenials: [], apiErrorStatus: null, costUsd: null, usage, model: null, durationMs: null },
});

const item = (o: Record<string, unknown> = {}) => ({
  text: "BTL-12 不做了，需求变了", kind: "state_change", speaker: "user", quote: "ticket 也不做了", targets: ["ticket:BTL-12", "coordinator:4"],
  importance: "high", confidence: 0.9, change: { op: "close_ticket", ticket: "BTL-12", reason: "需求变了", closePrs: true }, ...o,
});

const ctx: ExtractContext = {
  source: "epic 登录改版（id 4）的总控",
  epics: [{ id: 4, name: "登录改版" }],
  tickets: [{ key: "BTL-12", title: "导出按钮", epicId: 4, feature: "导出", status: "in_progress" }],
  features: [{ id: 7, epicId: 4, name: "导出" }],
};

afterEach(() => setLang("zh"));

describe("parseExtraction", () => {
  it("accepts a well-formed answer", () => {
    const r = parseExtraction({ items: [item()] });
    expect(r).toEqual({
      ok: true, dropped: 0,
      items: [{
        text: "BTL-12 不做了，需求变了", kind: "state_change", speaker: "user", quote: "ticket 也不做了", targets: ["ticket:BTL-12", "coordinator:4"],
        importance: "high", confidence: 0.9, change: { op: "close_ticket", ticket: "BTL-12", feature: undefined, reason: "需求变了", closePrs: true },
      }],
    });
  });

  it.each([null, undefined, "items", 42, [], { items: "x" }, { nope: [] }])("fails safely on %j", (v) => {
    expect(parseExtraction(v).ok).toBe(false);
  });

  it("drops malformed items one by one and keeps the good ones", () => {
    const r = parseExtraction({
      items: [
        item({ kind: "gossip" }),
        item({ text: "   " }),
        item({ confidence: "high" }),
        item({ targets: "ticket:BTL-12" }),
        { text: "x" },
        "not an item",
        null,
        item({ change: { op: "delete_repo" } }),
        item({ text: "以后接口一律分页", kind: "convention", change: null }),
      ],
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.items.map((i) => i.text)).toEqual(["以后接口一律分页"]);
    expect(r.dropped).toBe(8);
  });

  it("clamps confidence, squashes whitespace, caps text, dedupes targets, and caps the item count", () => {
    const r = parseExtraction({
      items: [
        item({ confidence: 7, text: `  a\n\n b ${"长".repeat(FLOW_TEXT_LIMIT)}`, targets: ["ticket:BTL-12", " ticket:BTL-12 ", "", "workspace"] }),
        item({ confidence: -1 }),
        ...Array.from({ length: FLOW_MAX_ITEMS + 3 }, () => item()),
      ],
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.items).toHaveLength(FLOW_MAX_ITEMS);
    expect(r.items[0].confidence).toBe(1);
    expect(r.items[1].confidence).toBe(0);
    expect(r.items[0].text.startsWith("a b 长")).toBe(true);
    expect(r.items[0].text).toHaveLength(FLOW_TEXT_LIMIT);
    expect(r.items[0].targets).toEqual(["ticket:BTL-12", "workspace"]);
    expect(r.dropped).toBe(5);
  });

  it("masks secrets in text, quote and reason, and drops an item that was nothing but a secret", () => {
    const tok = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const r = parseExtraction({
      items: [
        item({ text: `CI 用 ${tok} 推镜像`, quote: `用 ${tok} 推`, change: { op: "close_ticket", ticket: "BTL-12", reason: `token ${tok} 泄露了`, closePrs: false } }),
        item({ text: tok }),
      ],
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.items).toHaveLength(1);
    expect(r.dropped).toBe(1);
    const [i] = r.items;
    expect(JSON.stringify(i)).not.toContain("ghp_");
    expect(i.text).toBe("CI 用 [REDACTED] 推镜像");
    expect(i.quote).toBe("用 [REDACTED] 推");
    expect(i.change?.reason).toBe("token [REDACTED] 泄露了");
  });

  it("masks and caps the ticket and feature the model gave (they go onto cards and to the coordinators)", () => {
    const tok = "sk_live_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
    const r = parseExtraction({
      items: [item({ change: { op: "set_ticket_feature", ticket: `BTL-12 ${tok}`, feature: `登录 ${tok} ${"长".repeat(400)}` } })],
    });
    if (!r.ok) throw new Error("expected ok");
    const c = r.items[0].change!;
    expect(JSON.stringify(c)).not.toContain("sk_live_");
    expect(c.ticket).toContain("[REDACTED]");
    expect(c.ticket!.length).toBeLessThanOrEqual(64);
    expect(typeof c.feature === "string" && c.feature.length <= 200).toBe(true);
  });

  it("caps text in UTF-16 units (the memory's measure) without splitting a surrogate pair", () => {
    const r = parseExtraction({ items: [item({ text: `a${"😀".repeat(FLOW_TEXT_LIMIT)}` })] });
    if (!r.ok) throw new Error("expected ok");
    const t = r.items[0].text;
    expect(t.length).toBeLessThanOrEqual(FLOW_TEXT_LIMIT);
    expect(t.length).toBeGreaterThan(FLOW_TEXT_LIMIT - 2);
    expect(t.endsWith("😀")).toBe(true);
  });

  it("treats a missing change as none and only sets closePrs when the model said true", () => {
    const r = parseExtraction({ items: [item({ change: undefined }), item({ change: { op: "close_ticket", ticket: " BTL-12 " } })] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.items[0].change).toBeNull();
    expect(r.items[1].change).toEqual({ op: "close_ticket", ticket: "BTL-12", feature: undefined, reason: null, closePrs: false });
  });
});

describe("extractPrompt", () => {
  it("lists the context and both sides in Chinese and English", () => {
    const zh = extractPrompt(ctx, { userText: "BTL-12 不做了", agentText: "好" });
    expect(zh).toContain("epic 登录改版（id 4）的总控");
    expect(zh).toContain("ticket:BTL-12 导出按钮 [in_progress] epic:4 feature「导出」");
    expect(zh).toContain("用户说：\nBTL-12 不做了");
    setLang("en");
    const en = extractPrompt(ctx, { userText: "", agentText: "done" });
    expect(en).toContain("User said:\n(nothing)");
    expect(en).toContain("This round is from: epic");
    expect(en).not.toContain("用户说");
  });
});

describe("extractTurn", () => {
  it("runs conv_relay with no tools and returns the parsed items", async () => {
    const seen: HeadlessRequest[] = [];
    const r = await extractTurn(deps(ok({ items: [item()] }), seen), ctx, { userText: "u", agentText: "a" }, { cwd: "/w", ticketKey: "BTL-12" });
    expect(r.ok && r.items).toHaveLength(1);
    expect(seen[0].args.join(" ")).toContain("--json-schema");
    expect(seen[0].args).not.toContain("Bash");
  });

  it("bad JSON from the model is a plain failure, not an exception", async () => {
    const r = await extractTurn(deps(ok(undefined, "sure! here you go: {items: [oops")), ctx, { userText: "u", agentText: "a" }, { cwd: "/w", ticketKey: null });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.later).toBe(false);
  });

  it("an answer of the wrong shape fails without writing anything", async () => {
    const r = await extractTurn(deps(ok({ facts: [] })), ctx, { userText: "u", agentText: "a" }, { cwd: "/w", ticketKey: null });
    expect(r).toMatchObject({ ok: false, later: false });
    expect(!r.ok && r.error).toMatch(/^bad_output/);
  });

  it("a thrown runner is a failure", async () => {
    const r = await extractTurn(deps(() => { throw new Error("boom"); }), ctx, { userText: "u", agentText: "a" }, { cwd: "/w", ticketKey: null });
    expect(r).toMatchObject({ ok: false, later: false });
  });

  it("a timeout is retried later", async () => {
    const r = await extractTurn(deps({ ok: false, reason: "timeout", message: "t", limit: null, stderr: "", result: null } as unknown as HeadlessOutcome), ctx, { userText: "u", agentText: "a" }, { cwd: "/w", ticketKey: null });
    expect(r).toMatchObject({ ok: false, later: true });
  });
});

describe("FLOW_JSON_SCHEMA (BTL-272)", () => {
  it("is a plain object schema whose items carry a quote (the e2e fake claude recognizes it by that)", async () => {
    const { FLOW_JSON_SCHEMA } = await import("./extract");
    const s = JSON.parse(typeof FLOW_JSON_SCHEMA === "string" ? FLOW_JSON_SCHEMA : JSON.stringify(FLOW_JSON_SCHEMA));
    expect(s.properties.items.items.properties.quote).toBeTruthy();
  });
});
