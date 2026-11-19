import { describe, expect, it } from "vitest";
import { sessionGuide } from "../claude/session-guide";
import type { ProfileProject, RepoProfile } from "../../shared/baselines";
import { evidenceGuideLines } from "./guide-lines";

const project = (o: Partial<ProfileProject>): ProfileProject => ({
  dir: "", langs: ["ts"], install: null, build: null, testAll: null, testOne: null, fastest: null, lint: null, typecheck: null, inferred: [], ...o,
});
const profile = (projects: ProfileProject[]): RepoProfile => ({ projects, dirs: [], ci: [], pitfalls: [] });

describe("evidence guide lines (ws-g §3.2)", () => {
  it("lists each repo's commands from its profile, and the generic line without one", () => {
    const [zh] = evidenceGuideLines("zh", [
      { name: "api", profile: profile([project({ testAll: "pnpm test", lint: "pnpm lint", typecheck: "pnpm typecheck" })]) },
      { name: "web", profile: profile([project({ dir: "app", testOne: "npx vitest run" }), project({ dir: "docs" })]) },
      { name: "infra", profile: null },
    ]);
    expect(zh).toContain("submit_evidence");
    expect(zh).toContain("- api：测试 `pnpm test`，lint `pnpm lint`，类型检查 `pnpm typecheck`");
    expect(zh).toContain("- web：app: 测试 `npx vitest run`");
    expect(zh).toContain("- infra：测试、lint、类型检查");
    const [en] = evidenceGuideLines("en", [{ name: "api", profile: profile([project({ build: "make" })]) }]);
    expect(en).toContain("- api: build `make`");
    expect(/[一-鿿]/.test(en)).toBe(false);
  });

  it("is only in the guide when the caller passes it; without it the guide is unchanged", () => {
    const off = sessionGuide("zh", "ticket", [], { preReview: false, extra: [] });
    expect(off).toBe(sessionGuide("zh", "ticket", [], {}));
    expect(off).not.toContain("submit_evidence");
    const on = sessionGuide("zh", "ticket", [{ label: "L1", text: "rule" } as never], { preReview: true, extra: evidenceGuideLines("zh", []) });
    expect(on).toContain("开 PR 之前会自动跑一次预审");
    expect(on).toContain("## 完成前交证据");
  });
});
