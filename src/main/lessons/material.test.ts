import { describe, expect, it } from "vitest";
import type { PrComment, PrLessonData, PrReview } from "../tickets/gh";
import { MATERIAL_MAX_CHARS, fixRange, materialText, reviewItems, transcriptExcerpts, type Material } from "./material";

const T = (hhmm: string): number => Date.parse(`2026-11-10T${hhmm}:00Z`);
const iso = (hhmm: string): string => `2026-11-10T${hhmm}:00.000Z`;

function cm(id: string, author: string, body: string, at: number, path: string | null = null): PrComment {
  return { id, author, body, createdAt: at, url: `https://x/${id}`, path, line: path ? 7 : null, reviewId: null };
}
function rv(id: string, author: string, state: PrReview["state"], body: string, at: number): PrReview {
  return { id, author, state, body, submittedAt: at };
}
function pr(over: Partial<PrLessonData> = {}): PrLessonData {
  return {
    number: 5, title: "T", body: "B", url: "https://x/5", author: "me", headRefName: "h", mergedAt: iso("13:00"),
    reviews: [], comments: [], inline: [],
    commits: [
      { oid: "c1", committedDate: iso("10:00"), headline: "one", body: "" },
      { oid: "c2", committedDate: iso("11:00"), headline: "two", body: "" },
      { oid: "c3", committedDate: iso("12:00"), headline: "three", body: "" },
    ],
    botLogins: new Set(["coderabbitai"]),
    ...over,
  };
}

describe("reviewItems", () => {
  it("keeps copilot and human, drops author, bots and empty approvals", () => {
    const items = reviewItems(
      pr({
        reviews: [rv("r1", "bob", "APPROVED", "  ", T("10:10")), rv("r2", "bob", "COMMENTED", "looks off", T("10:20"))],
        comments: [
          cm("c1", "me", "my reply", T("10:01")),
          cm("c2", "github-actions", "ci", T("10:02")),
          cm("c3", "coderabbitai", "nit", T("10:03")),
          cm("c4", "alice", "why?", T("10:04")),
        ],
        inline: [cm("i1", "copilot-pull-request-reviewer", "use const", T("10:30"), "src/a.ts")],
      }),
    );
    expect(items.map((i) => [i.author, i.who])).toEqual([
      ["alice", "human"],
      ["bob", "human"],
      ["copilot-pull-request-reviewer", "copilot"],
    ]);
    expect(items[2]).toMatchObject({ path: "src/a.ts", line: 7, at: iso("10:30") });
  });
  it("returns [] when only author and bots spoke", () => {
    expect(reviewItems(pr({ comments: [cm("a", "me", "x", 1), cm("b", "coderabbitai", "y", 2)] }))).toEqual([]);
  });
});

describe("fixRange", () => {
  const withInline = (hhmm: string) => {
    const p = pr({ inline: [cm("i", "alice", "fix", T(hhmm), "src/a.ts")] });
    return fixRange(p, reviewItems(p));
  };
  it("spans from the commit before the comment to the last", () => {
    expect(withInline("10:30")).toEqual({ base: "c1", head: "c3" });
  });
  it("is null when no commit follows the comment", () => {
    expect(withInline("12:30")).toBeNull();
  });
  it("is null without inline comments", () => {
    const p = pr({ comments: [cm("a", "alice", "x", T("10:30"))] });
    expect(fixRange(p, reviewItems(p))).toBeNull();
  });
});

describe("transcriptExcerpts", () => {
  const line = (content: unknown[], type = "assistant") => JSON.stringify({ type, message: { content } });
  it("keeps assistant text that mentions the file basename", () => {
    const jsonl = [
      line([{ type: "text", text: "I changed a.ts" }]),
      line([{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }]),
      line([{ type: "text", text: "a.ts please" }], "user"),
    ];
    expect(transcriptExcerpts(jsonl, ["x/src/a.ts"], 1000)).toEqual(["I changed a.ts"]);
  });
  it("prefers the newest within maxChars", () => {
    const jsonl = [line([{ type: "text", text: "old a.ts" }]), line([{ type: "text", text: "new a.ts" }])];
    expect(transcriptExcerpts(jsonl, ["a.ts"], 10)).toEqual(["new a.ts"]);
  });
});

describe("materialText", () => {
  it("stays within the cap and keeps every author", () => {
    const big = "x".repeat(50_000);
    const items = ["alice", "bob", "carol", "dave"].map((a, i) => ({
      who: "human" as const, author: a, body: big, url: null, path: "src/a.ts", line: i, at: iso("10:00"),
    }));
    const m: Material = {
      pr: pr({ body: "PRBODY" }),
      items,
      fixes: [{ filename: "src/a.ts", patch: big }],
      butler: { ticketKey: "BTL-1", decisions: ["d"], learnings: ["l"], excerpts: [big, big] },
    };
    for (const lang of ["zh", "en"] as const) {
      const t = materialText(m, lang);
      expect(t.length).toBeLessThanOrEqual(MATERIAL_MAX_CHARS);
      for (const a of ["alice", "bob", "carol", "dave"]) expect(t).toContain(a);
      expect(t).toContain("PRBODY");
      expect(t).toContain("one");
    }
  });
  it("includes butler context and fixes when small", () => {
    const m: Material = {
      pr: pr(), items: [], fixes: [{ filename: "f.ts", patch: "PATCH" }],
      butler: { ticketKey: "BTL-1", decisions: ["DEC"], learnings: ["LRN"], excerpts: ["EXC"] },
    };
    const t = materialText(m, "en");
    for (const s of ["PATCH", "f.ts", "BTL-1", "DEC", "LRN", "EXC"]) expect(t).toContain(s);
  });
  const names = Array.from({ length: 12 }, (_, i) => `rev${i}`);
  const mk = (n: number, body: string, prBody = "B"): Material => ({
    pr: pr({ body: prBody }),
    items: Array.from({ length: n }, (_, i) => ({
      who: "human" as const, author: n === 12 ? names[i]! : `user${i}`, body, url: null, path: null, line: null, at: iso("10:00"),
    })),
    fixes: [], butler: null,
  });
  it("caps a 70k PR body so every author survives", () => {
    const t = materialText(mk(12, "y".repeat(1500), "p".repeat(70_000)), "en");
    expect(t.length).toBeLessThanOrEqual(MATERIAL_MAX_CHARS);
    for (const a of names) expect(t).toContain(a);
  });
  it("falls back to per-item shares when hundreds of items overflow", () => {
    const m = mk(300, "z".repeat(1500));
    const t = materialText(m, "zh");
    expect(t.length).toBeLessThanOrEqual(MATERIAL_MAX_CHARS);
    for (const i of m.items) expect(t).toContain(`${i.author} (`);
    expect(t).toContain("user299 (");
  });
});
