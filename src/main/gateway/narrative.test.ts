import { describe, expect, it } from "vitest";
import { NARRATIVE_SYSTEM_PROMPT, narrativeMessages, parseNarrative } from "./narrative";
import { DEFAULT_TICKET_PATTERN, scanOutbound } from "./scanner";

describe("narrative prompt and reply", () => {
  it("sends the fixed system prompt and the payload as JSON, and the prompt itself passes the scanner", () => {
    const payload = { date: "2026-10-21", tickets: [], items: [] };
    expect(narrativeMessages(payload)).toEqual([
      { role: "system", content: NARRATIVE_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ]);
    expect(scanOutbound([NARRATIVE_SYSTEM_PROMPT], { ticketPattern: DEFAULT_TICKET_PATTERN, originals: [] })).toEqual([]);
  });

  it("parses the focus list leniently and rejects anything else", () => {
    expect(parseNarrative('{"focus":["先合并 PR。","再处理阻塞。"]}')).toEqual(["先合并 PR。", "再处理阻塞。"]);
    expect(parseNarrative('```json\n{"focus": [" 先合并 "]}\n```')).toEqual(["先合并"]);
    expect(parseNarrative('好的，今日重点如下：{"focus":["一"]}')).toEqual(["一"]);
    for (const bad of ["今天先合并 PR。", '{"focus":[]}', '{"focus":"一"}', `{"focus":${JSON.stringify(Array(7).fill("x"))}}`, "{broken"]) {
      expect(parseNarrative(bad), bad).toBeNull();
    }
  });
});
