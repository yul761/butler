import { describe, it, expect } from "vitest";
import { parseUsageLine, usageCounts, usageOfLongLine } from "./usage-parse";

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

describe("usageOfLongLine", () => {
  /** Claude Code 写的样子：message.id、model 在 content 前面，usage、requestId、type、timestamp 在后面。 */
  const big = (o: { type?: string; usageInContent?: boolean } = {}) => {
    const filler = (o.usageInContent ? JSON.stringify({ usage: { input_tokens: 999999, output_tokens: 999999 } }) : "") + "x".repeat(200_000);
    return JSON.stringify({
      parentUuid: "p", sessionId: "s",
      message: {
        model: "claude-opus-5-5", id: "msg_long", type: "message", role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", input: { text: filler } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 700, output_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 }, server_tool_use: { web_search_requests: 0 } },
      },
      requestId: "req_long", type: o.type ?? "assistant", uuid: "u", timestamp: "2026-11-27T01:02:03.000Z",
    });
  };
  const ends = (text: string, n = 64 * 1024) => [text.slice(0, n), text.slice(-n)] as const;

  it("takes the same usage from the two ends of a line as from the whole line", () => {
    const text = big();
    expect(usageOfLongLine(...ends(text))).toEqual(parseUsageLine(text));
    expect(usageOfLongLine(...ends(text))).toMatchObject({ messageId: "msg_long", model: "claude-opus-5-5", input: 3, cacheWrite5m: 10, cacheRead: 700, output: 50 });
  });

  it("does not take a usage that is only text inside the content", () => {
    const text = big({ usageInContent: true });
    expect(usageOfLongLine(...ends(text))).toMatchObject({ input: 3, output: 50 });
    expect(usageOfLongLine(text.slice(0, 1000), "")).toBeNull();
  });

  it("finds nothing in a line that is not an assistant turn", () => {
    expect(usageOfLongLine(...ends(big({ type: "user" })))).toBeNull();
    expect(usageOfLongLine("x".repeat(100), "y".repeat(100))).toBeNull();
  });

  it("takes message.id wherever it sits before the content, and never a content block's id", () => {
    const text = big();
    // 和同一个回复的其他行（每个内容块一行，message.id 相同）用同一个 id，才能去重。
    expect(usageOfLongLine(...ends(text))?.messageId).toBe("msg_long");
    const noId = text.replace('"id":"msg_long",', "");
    expect(usageOfLongLine(...ends(noId))?.messageId).toBe("req_long");
  });

  it("falls back to requestId when the start of the line has no message id", () => {
    const text = big();
    expect(usageOfLongLine("{}", text.slice(-64 * 1024))).toMatchObject({ messageId: "req_long", model: null, output: 50 });
  });
});
