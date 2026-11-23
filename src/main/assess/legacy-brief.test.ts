// BTL-260：改名前写进 PR 描述的简报块用 butler:brief 标记，已经在 GitHub 上了。butler 是旧名字。
import { describe, expect, it } from "vitest";
import { BRIEF_END, BRIEF_START } from "../../shared/prereview";
import { upsertBriefBlock } from "./brief";
import { stripShipherdBlocks } from "./readiness";

const OLD = "<!-- butler:brief -->\nold brief\n<!-- /butler:brief -->";
const NEW = `${BRIEF_START}\nnew brief\n${BRIEF_END}`;

describe("PR brief written before the rename", () => {
  it("is replaced in place, not followed by a second brief", () => {
    const body = `What: x\n\n${OLD}\n\nfooter`;
    const out = upsertBriefBlock(body, NEW);
    expect(out).toBe(`What: x\n\n${NEW}\n\nfooter`);
    expect(out).not.toContain("butler:brief");
    expect(upsertBriefBlock(out, NEW)).toBe(out);
  });

  it("is left out when the description is checked", () => {
    expect(stripShipherdBlocks(`What: x\n${OLD}\n<!-- butler:note -->`)).toBe("What: x");
    expect(stripShipherdBlocks(`What: x\n${NEW}`)).toBe("What: x");
    // 开头和结尾的名字要一致：butler 开头、shipherd 结尾的不算一块。
    expect(stripShipherdBlocks("<!-- butler:brief -->\nkeep\n<!-- /shipherd:brief -->")).toBe("keep");
  });
});
