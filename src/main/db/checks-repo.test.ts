import { describe, expect, it } from "vitest";
import type { CheckInput } from "../../shared/checks";
import { memDb } from "../test-utils";
import { ChecksRepo } from "./checks-repo";
import { LessonsRepo } from "./lessons-repo";

const fp = (over: Partial<CheckInput> = {}): CheckInput => ({
  type: "forbidden_pattern", name: "no foo", params: { pattern: "foo" }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "enforce", enabled: true, message: "fix it", ...over,
});

describe("ChecksRepo.enforcedLessonIds (BTL-274)", () => {
  it("only lessons whose check is enabled and enforcing count as handled by a check", () => {
    const db = memDb();
    const lessons = new LessonsRepo(db);
    lessons.upsertRepo("acme/web", "/x", 1);
    const ins = db.prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at) VALUES ('acme/web', ?, '', 'confirmed', 1, 1, 1, 1)");
    const mk = (t: string) => Number(ins.run(t).lastInsertRowid);
    const [a, b, c, d] = ["a", "b", "c", "d"].map(mk);
    const checks = new ChecksRepo(db);
    const scope = { kind: "repo", slug: "acme/web" } as const;
    checks.insert(scope, "k1", fp(), { lessonId: a, now: 1 });
    checks.insert(scope, "k2", fp({ enabled: false }), { lessonId: b, now: 1 });
    checks.insert(scope, "k3", fp({ mode: "shadow" }), { lessonId: c, now: 1 });
    const del = checks.insert(scope, "k4", fp(), { lessonId: d, now: 1 });
    db.prepare("DELETE FROM checks WHERE id = ?").run(del);
    checks.insert(scope, "k5", fp(), { now: 1 });
    expect([...checks.enforcedLessonIds()]).toEqual([a]);
  });
});
