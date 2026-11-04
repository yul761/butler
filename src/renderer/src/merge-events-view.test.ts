import { describe, expect, it } from "vitest";
import type { MergeEvent } from "../../shared/types";
import { mergeEventText } from "./merge-events-view";
import { STRINGS } from "./strings";

const ev = (o: Partial<MergeEvent>): MergeEvent => ({
  id: 1, repoPath: "/code/app", kind: "wait", ticketKey: "BTL-1", branch: "feat/a",
  otherTicket: "BTL-2", otherBranch: "feat/b", files: [], createdAt: 0, ...o,
});

describe("mergeEventText", () => {
  it("四种 kind 的文字", () => {
    expect(mergeEventText(ev({ kind: "wait" }), STRINGS.zh).text).toBe("BTL-1 等 BTL-2 合完再合");
    expect(mergeEventText(ev({ kind: "proceed_conflict" }), STRINGS.zh).text).toBe("BTL-1 先合，BTL-2 之后要 rebase");
    expect(mergeEventText(ev({ kind: "rebase" }), STRINGS.zh).text).toBe("BTL-1 要先 rebase 再合");
    expect(mergeEventText(ev({ kind: "dir_busy" }), STRINGS.zh).text).toBe("BTL-1 想切 branch，目录正被 BTL-2 用着");
    expect(mergeEventText(ev({ kind: "wait" }), STRINGS.en).text).toBe("BTL-1 waits for BTL-2 to finish merging");
  });

  it("ticket 为空时用 branch 名，且不生成 ticket 片段", () => {
    const r = mergeEventText(ev({ ticketKey: null, otherTicket: null }), STRINGS.zh);
    expect(r.text).toBe("feat/a 等 feat/b 合完再合");
    expect(r.parts.some((p) => typeof p !== "string")).toBe(false);
  });

  it("片段里 ticket 号单独出来，便于渲染成按钮", () => {
    expect(mergeEventText(ev({}), STRINGS.zh).parts).toEqual([{ ticket: "BTL-1" }, " 等 ", { ticket: "BTL-2" }, " 合完再合"]);
  });

  it("repo 取最后一段，Windows 路径也对", () => {
    expect(mergeEventText(ev({ repoPath: "/code/app" }), STRINGS.zh).repo).toBe("app");
    expect(mergeEventText(ev({ repoPath: "C:\\code\\app\\" }), STRINGS.zh).repo).toBe("app");
  });
});
