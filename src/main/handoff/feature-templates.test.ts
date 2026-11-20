import { describe, expect, it } from "vitest";
import { FeatureHandoffSchema, type Handoff } from "../../shared/handoff";
import { defaultFeatureHandoffPrompt, featureHandoffExample, renderFeatureTickets, turnLabel, type FeatureTicketContext } from "./feature-templates";
import { emptyHandoff } from "./schema";
import type { WatchedPr } from "../../shared/types";
import type { Turn } from "../../shared/turn";

const hasChinese = (s: string) => /[一-鿿]/.test(s);

const latest = (over: Partial<Handoff>): Handoff => ({ ...emptyHandoff("A-1"), ...over });

const rows = (l: "zh" | "en"): FeatureTicketContext[] => [
  {
    key: "A-1", title: l === "zh" ? "登录页" : "Login page", status: "in_review",
    prs: [{ number: 455, url: "https://github.com/acme/web/pull/455", state: "open", review: "pending" }],
    latest: latest({
      done_today: [l === "zh" ? "改完 token 刷新" : "Finished the token refresh"],
      next_steps: [l === "zh" ? "和 B-2 联调接口" : "Wire the API up with B-2", l === "zh" ? "补 e2e" : "Add e2e"],
      blockers: [],
    }),
  },
  { key: "B-2", title: null, status: "active", prs: [], latest: null },
];

describe("renderFeatureTickets", () => {
  it("lists each ticket with its PRs and the latest handoff (Chinese)", () => {
    expect(renderFeatureTickets(rows("zh"), "zh")).toBe(
      [
        "- A-1 登录页（状态：in_review）",
        "  PR：web#455 open (pending)",
        "  最近完成：改完 token 刷新",
        "  下一步：和 B-2 联调接口；补 e2e",
        "  卡住：无",
        "- B-2 无标题（状态：active）",
        "  PR：还没有",
        "  （还没有 handoff）",
      ].join("\n"),
    );
    expect(renderFeatureTickets([], "zh")).toBe("（这个 feature 下还没有 ticket）");
  });

  it("lists each ticket with its PRs and the latest handoff (English)", () => {
    const text = renderFeatureTickets(rows("en"), "en");
    expect(text).toBe(
      [
        "- A-1 Login page (status: in_review)",
        "  PRs: web#455 open (pending)",
        "  Recently done: Finished the token refresh",
        "  Next: Wire the API up with B-2; Add e2e",
        "  Blocked by: nothing",
        "- B-2 untitled (status: active)",
        "  PRs: none yet",
        "  (no handoff yet)",
      ].join("\n"),
    );
    expect(hasChinese(text)).toBe(false);
    expect(renderFeatureTickets([], "en")).toBe("(this feature has no tickets yet)");
  });
});

describe("feature summary prompt", () => {
  it("has the placeholders and the rules in both languages", () => {
    for (const l of ["zh", "en"] as const) {
      const p = defaultFeatureHandoffPrompt(l);
      for (const ph of ["{{feature}}", "{{previous}}", "{{tickets}}"]) expect(p).toContain(ph);
      expect(p).toContain("next_steps");
    }
    const zh = defaultFeatureHandoffPrompt("zh");
    for (const s of ["整体进度", "跨 ticket", "只写 ticket 号", "百分比", "不要修改任何文件"]) expect(zh).toContain(s);
    const en = defaultFeatureHandoffPrompt("en");
    for (const s of ["overall progress", "across tickets", "only by its id", "percentage", "don't change any file"]) expect(en).toContain(s);
    expect(hasChinese(en)).toBe(false);
  });

  it("ships examples that pass the schema", () => {
    for (const l of ["zh", "en"] as const) expect(FeatureHandoffSchema.safeParse(JSON.parse(featureHandoffExample(l))).success).toBe(true);
  });
});

describe("turnLabel", () => {
  it("says whose turn it is with the reason or the names", () => {
    expect(turnLabel({ owner: "you", kind: "unattended", why: "conflicts", canSend: false, sessionId: null })).toBe("user (unattended: conflicts)");
    expect(turnLabel({ owner: "external", kind: "awaiting_review", names: ["amy", "core"] })).toBe("external (awaiting_review: amy, core)");
    expect(turnLabel({ owner: "external", kind: "ci_running", names: [] })).toBe("external (ci_running)");
    expect(turnLabel({ owner: "agent", kind: "fixing_ci", sessionId: "s" })).toBe("agent (fixing_ci)");
  });
});

describe("renderFeatureTickets with live PRs and turns", () => {
  const live = (number: number, state: "open" | "merged"): WatchedPr => ({
    ticketKey: "A-1", prId: number, repoId: 1, repoPath: "/code/web", branch: "b", number, url: `https://github.com/acme/web/pull/${number}`,
    state, review: null, ci: "passing", headSha: null, checkedAt: 1, readError: false,
  });
  it("writes whose turn an open PR is, asks with the ticket, and skips the turn of a merged PR", () => {
    const asked: (string | undefined)[] = [];
    const turnOf = (url: string, key?: string): Turn => (asked.push(key), url.endsWith("/1") ? { owner: "external", kind: "awaiting_review", names: ["amy"] } : { owner: "done", kind: "merged" });
    const text = renderFeatureTickets([{ ...rows("zh")[0], live: [live(1, "open"), live(2, "merged")], turnOf }], "zh");
    expect(text).toContain("web#1 open，CI passing，轮到：external (awaiting_review: amy)");
    expect(text).toContain("web#2 merged，CI passing");
    expect(text).not.toContain("web#2 merged，CI passing，轮到");
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["A-1"]));
  });
});
