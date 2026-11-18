import { describe, expect, it } from "vitest";
import { joinProfiles, profileText, ELLIPSIS } from "./profile-text";
import { scanFiles } from "./scan";
import { resolveRules } from "./rules";
import { JS_REPO, MONO_REPO } from "./__fixtures__/repos";
import type { RepoProfile } from "../../shared/baselines";

const profileOf = (repo: Record<string, string>): RepoProfile => scanFiles({ files: Object.keys(repo), read: (p) => repo[p] ?? null, rules: resolveRules([]) }).profile;
const at = Date.UTC(2026, 10, 18);

describe("profile text", () => {
  it("lists the repo's commands for a single project", () => {
    const p = profileOf(JS_REPO);
    const t = profileText({ slug: "a/web", scannedAt: at, profile: p }, { lang: "en", maxChars: 2000, stale: false, pitfalls: true });
    expect(t).toContain("Repo a/web (scanned 2026-11-18");
    expect(t).toMatch(/- all tests: `pnpm (run )?test`/);
    expect(t).not.toContain(ELLIPSIS);
  });
  it("marks stale and inferred, and adds pitfalls only when asked", () => {
    const p: RepoProfile = { projects: [{ dir: "", langs: [], install: null, build: null, testAll: "./tools/check.sh", testOne: null, fastest: null, lint: null, typecheck: null, inferred: ["testAll"] }], dirs: [], ci: [], pitfalls: ["Run migrations first"] };
    const zh = profileText({ slug: "a/ci", scannedAt: at, profile: p }, { lang: "zh", maxChars: 2000, stale: true, pitfalls: true });
    expect(zh).toContain("`./tools/check.sh`（推断）");
    expect(zh).toContain("配置文件改过");
    expect(zh).toContain("Run migrations first");
    expect(profileText({ slug: "a/ci", scannedAt: at, profile: p }, { lang: "en", maxChars: 2000, stale: false, pitfalls: false })).not.toContain("migrations");
    expect(profileText({ slug: "a/x", scannedAt: at, profile: { projects: [], dirs: [], ci: [], pitfalls: [] } }, { lang: "en", maxChars: 100, stale: false, pitfalls: true })).toBe("");
  });
  it("cuts CI, layout and secondary projects first to fit the limit", () => {
    const p = profileOf(MONO_REPO);
    const full = profileText({ slug: "a/mono", scannedAt: at, profile: p }, { lang: "en", maxChars: 10_000, stale: false, pitfalls: false });
    const lines = full.split("\n");
    const limit = Math.floor(full.length * 0.6);
    const cut = profileText({ slug: "a/mono", scannedAt: at, profile: p }, { lang: "en", maxChars: limit, stale: false, pitfalls: false });
    expect(cut.length).toBeLessThanOrEqual(limit);
    expect(cut.endsWith(ELLIPSIS)).toBe(true);
    expect(cut.split("\n").slice(0, 3)).toEqual(lines.slice(0, 3));
    const tiny = profileText({ slug: "a/mono", scannedAt: at, profile: p }, { lang: "en", maxChars: 40, stale: false, pitfalls: false });
    expect(tiny.length).toBeLessThanOrEqual(40);
  });
  it("joins several repos under a total", () => {
    expect(joinProfiles(["aaaa", "", "bbbb", "cccc"], 13)).toBe(`aaaa\n\nbbbb\n\n${ELLIPSIS}`);
  });
});
