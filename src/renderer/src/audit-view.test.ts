import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../shared/llm";
import { auditStatusLabel, auditSummary, blockedText, bodyHeading, bodyMaybeSent, prettyBody, prettyJson } from "./audit-view";

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1, ts: 1, provider: "api.deepseek.com", model: "deepseek-chat", level: "metadata", status: "sent",
  payloadSent: null, response: null, tokensIn: 120, tokensOut: 40, costUsd: 0.0023, blockedReason: null, error: null, ...over,
});

describe("audit view helpers", () => {
  it("labels every status", () => {
    for (const s of ["pending", "sent", "failed", "blocked", "budget", "declined"] as const) expect(auditStatusLabel(s).length).toBeGreaterThan(0);
  });

  it("summarises an entry and explains a block", () => {
    expect(auditSummary(entry())).toBe("仅元数据（默认） · 已发送 · 120 / 40 token · $0.0023");
    expect(auditSummary(entry({ status: "blocked", tokensIn: null, tokensOut: null, costUsd: null }))).toBe("仅元数据（默认） · 已拦截");
    expect(blockedText([{ rule: "url", sample: "htt…(23)" }, { rule: "secret", sample: "sk-…(40)" }])).toBe("网址（htt…(23)）；密钥或令牌（sk-…(40)）");
    expect(blockedText(null)).toBe("");
  });

  it("pretty-prints the request body including the JSON inside messages, and leaves non-JSON alone", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "system", content: "提示" }, { role: "user", content: '{"date":"2026-10-21"}' }] });
    const out = prettyBody(body);
    expect(out).toContain('"date": "2026-10-21"');
    expect(out).toContain('"content": "提示"');
    expect(prettyBody("not json")).toBe("not json");
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson(null)).toBe("");
  });

  it("never throws on odd input and falls back to the raw text", () => {
    for (const t of ["", "null", "42", '"s"', "[1,", '{"messages":null}', '{"messages":[null,1,"x"]}', '{"messages":[{"content":"[1,"}]}']) {
      expect(() => prettyBody(t)).not.toThrow();
      expect(() => prettyJson(t)).not.toThrow();
    }
    expect(prettyBody("[1,")).toBe("[1,");
    expect(prettyBody('{"messages":[null,1]}')).toContain("null");
  });

  it("handles a 500 KB body in one quick pass", () => {
    const inner = JSON.stringify({ items: Array.from({ length: 6000 }, (_, i) => ({ k: `PROJ-${i}`, t: "x".repeat(40) })) });
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: inner }, { role: "user", content: "y".repeat(100_000) }] });
    expect(body.length).toBeGreaterThan(500_000);
    const t0 = Date.now();
    const out = prettyBody(body);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out).toContain('"k": "PROJ-5999"');
    expect(prettyBody("z".repeat(500_000))).toHaveLength(500_000);
  });

  it("keeps showing the body of a failed row", () => {
    const e = entry({ status: "failed", payloadSent: '{"a":1}', error: "x" });
    expect(auditSummary(e)).toContain("发送失败");
    expect(prettyBody(e.payloadSent ?? "")).toBe('{\n  "a": 1\n}');
  });

  it("only calls the body 'sent' when the call is known to have been sent", () => {
    expect(bodyHeading("sent")).toBe("发出的内容");
    for (const st of ["failed", "pending"] as const) {
      expect(bodyHeading(st)).toBe("可能已发出的内容");
      expect(bodyMaybeSent(st)).toBe(true);
    }
    expect(bodyMaybeSent("sent")).toBe(false);
  });
});
