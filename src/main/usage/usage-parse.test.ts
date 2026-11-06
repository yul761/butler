import { describe, it, expect } from "vitest";
import { parseUsageLine, usageCounts } from "./usage-parse";

const line = (o: object) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-06T10:00:00.000Z",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 5000,
        output_tokens: 40,
        cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 },
      },
    },
    ...o,
  });

describe("parseUsageLine", () => {
  it("parses one assistant turn", () => {
    expect(parseUsageLine(line({}))).toEqual({
      messageId: "msg_1",
      at: Date.parse("2026-11-06T10:00:00.000Z"),
      model: "claude-opus-5-5",
      input: 2,
      cacheWrite5m: 0,
      cacheWrite1h: 100,
      cacheRead: 5000,
      output: 40,
      context: 5102,
    });
  });

  it("falls back when cache_creation is missing", () => {
    const l = JSON.stringify({
      type: "assistant",
      message: { id: "m", usage: { input_tokens: 1, cache_creation_input_tokens: 30, cache_read_input_tokens: 0, output_tokens: 1 } },
    });
    expect(parseUsageLine(l)).toMatchObject({ cacheWrite5m: 30, cacheWrite1h: 0, context: 31 });
  });

  it("uses requestId when message.id is missing and skips lines with neither", () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    const a = JSON.stringify({ type: "assistant", requestId: "req_9", message: { usage } });
    expect(parseUsageLine(a)?.messageId).toBe("req_9");
    const b = JSON.stringify({ type: "assistant", message: { usage } });
    expect(parseUsageLine(b)).toBeNull();
  });

  it("ignores user lines, summaries, malformed json and assistant lines without usage", () => {
    expect(parseUsageLine(line({ type: "user" }))).toBeNull();
    expect(parseUsageLine(JSON.stringify({ type: "summary", summary: "x", usage: {} }))).toBeNull();
    expect(parseUsageLine('{"type":"assistant","usage":')).toBeNull();
    expect(parseUsageLine(JSON.stringify({ type: "assistant", message: { id: "m" } }))).toBeNull();
    expect(parseUsageLine("")).toBeNull();
  });

  it("dedupes split content blocks", () => {
    // 去重由 Task 2 的主键完成，这里只断言三行解析出同一个 messageId
    const ids = [1, 2, 3].map((i) => parseUsageLine(line({ uuid: `u${i}` }))?.messageId);
    expect(ids).toEqual(["msg_1", "msg_1", "msg_1"]);
  });

  it("falls back to now when the timestamp is unparsable", () => {
    const before = Date.now();
    const t = parseUsageLine(line({ timestamp: "nope" }));
    expect(t!.at).toBeGreaterThanOrEqual(before);
  });
});

describe("usageCounts", () => {
  it("returns null for non-objects", () => {
    expect(usageCounts(null)).toBeNull();
    expect(usageCounts("x")).toBeNull();
  });
});
