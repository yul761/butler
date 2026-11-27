import { describe, expect, it } from "vitest";
import { locate, resetLessonDrip, runLessonDrip, type DripDeps } from "./lessons";
import { lessonsHookCommand, lessonsResetCommand, type DripManifest } from "../src/shared/lesson-drip";
import { LESSON_DRIP_LIMIT } from "../src/shared/lessons";

const ROOT = "/data/lesson-drip";
const env = { SHIPHERD_SESSION: "s1" };

function fs(files: Record<string, string> = {}, platform: NodeJS.Platform = "linux") {
  const f = new Map(Object.entries(files));
  // hook 用 path.join 拼文件名：在 Windows 上跑测试时是反斜杠，键统一成正斜杠再存取。
  const k = (p: string) => p.replace(/\\/g, "/");
  const d: DripDeps = {
    read: (p) => f.get(k(p)) ?? null,
    append: (p, t) => f.set(k(p), (f.get(k(p)) ?? "") + t),
    remove: (p) => void f.delete(k(p)),
    exists: (p) => f.has(k(p)),
    lock: (p) => (f.has(k(p)) ? false : (f.set(k(p), ""), true)),
    sleep: () => {},
    platform,
  };
  return { f, d };
}

const lesson = (id: number, slug: string, globs: string[] = [], text = `rule ${id}`, extra: Partial<DripManifest["lessons"][number]> = {}) => ({
  id, label: slug, text, why: "", globs, lang: null, slugs: [slug], ...extra,
});

// 两个仓库的 worktree 里有同名的相对路径（同一个 ticket 的两个仓库用同名分支）。
const manifest = (lessons: DripManifest["lessons"]): string =>
  JSON.stringify({
    v: 1, lang: "en",
    roots: [{ slug: "acme/web", dirs: ["/wt/web", "/repos/web"] }, { slug: "acme/api", dirs: ["/wt/api"] }],
    lessons,
  } satisfies DripManifest);

const edit = (file: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file }, ...extra });
const ctx = (out: string): string => (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

describe("runLessonDrip", () => {
  it("sends the full text of lessons whose scope matches the edited file, once per session", () => {
    const { f, d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web", ["src/db/**"], "Re-read in the write transaction"), lesson(2, "acme/web", ["docs/**"])]) });
    const run = runLessonDrip(edit("/wt/web/src/db/repo.ts"), env, ROOT, d);
    expect(ctx(run.out)).toContain("#1 [acme/web] Re-read in the write transaction");
    expect(ctx(run.out)).toContain("src/db/repo.ts");
    expect(ctx(run.out)).not.toContain("#2");
    run.commit();
    expect(f.get(`${ROOT}/s1.sent`)).toBe("1\n");
    expect(runLessonDrip(edit("/wt/web/src/db/other.ts"), env, ROOT, d).out).toBe("");
  });

  it("an edit in one repo never sends the other repo's lessons, even for the same relative path", () => {
    const { d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web", ["src/**"]), lesson(2, "acme/api", ["src/**"])]) });
    const web = runLessonDrip(edit("/wt/web/src/a.ts"), env, ROOT, d);
    expect(ctx(web.out)).toContain("#1");
    expect(ctx(web.out)).not.toContain("#2");
    web.release();
    const api = runLessonDrip(edit("/wt/api/src/a.ts"), env, ROOT, d);
    expect(ctx(api.out)).toContain("#2");
    expect(ctx(api.out)).not.toContain("#1");
  });

  it("sends a product lesson in every repo of the session that belongs to the product", () => {
    const { d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(5, "shop", [], "plain names", { slugs: ["acme/web", "acme/api"] })]) });
    expect(ctx(runLessonDrip(edit("/wt/api/x.ts"), env, ROOT, d).out)).toContain("#5 [shop] plain names");
  });

  it("sends unscoped lessons on the first edit, and ignores files outside every repo", () => {
    const { d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(3, "acme/web")]) });
    expect(runLessonDrip(edit("/elsewhere/x.ts"), env, ROOT, d).out).toBe("");
    expect(runLessonDrip(edit("/wt/website/x.ts"), env, ROOT, d).out).toBe("");
    expect(ctx(runLessonDrip(edit("/repos/web/x.ts"), env, ROOT, d).out)).toContain("#3");
  });

  it("respects scopeLang", () => {
    const { d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(4, "acme/web", [], "sql rule", { lang: "sql" })]) });
    expect(runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d).out).toBe("");
    expect(ctx(runLessonDrip(edit("/wt/web/m/001.sql"), env, ROOT, d).out)).toContain("#4");
  });

  it("keeps what does not fit for the next edit; once the main session has everything, a subagent still gets it", () => {
    const long = "x".repeat(LESSON_DRIP_LIMIT - 500);
    const { f, d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web", [], long), lesson(2, "acme/web", [], long)]) });
    const first = runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d);
    expect(ctx(first.out)).toContain("#1");
    expect(ctx(first.out)).not.toContain("#2");
    first.commit();
    expect(f.has(`${ROOT}/s1.json`)).toBe(true);
    const second = runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d);
    expect(ctx(second.out)).toContain("#2");
    second.commit();
    expect(f.has(`${ROOT}/s1.json`)).toBe(true);
    expect(runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d).out).toBe("");
    // 子 agent 有自己的上下文：主 session 全送完了，它改到匹配的文件照样收到。
    const sub = runLessonDrip(edit("/wt/web/a.ts", { agent_id: "ag-1" }), env, ROOT, d);
    expect(ctx(sub.out)).toContain("#1");
  });

  it("does not mark anything sent when stdout was not written (no commit)", () => {
    const { f, d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web")]) });
    const run = runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d);
    expect(run.out).not.toBe("");
    run.release();
    expect(f.has(`${ROOT}/s1.sent`)).toBe(false);
    expect(runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d).out).not.toBe("");
  });

  it("a subagent gets the lessons for its edit but the main session still gets them later", () => {
    const { f, d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web")]) });
    const sub = runLessonDrip(edit("/wt/web/a.ts", { agent_id: "ag/1" }), env, ROOT, d);
    expect(ctx(sub.out)).toContain("#1");
    sub.commit();
    expect(f.get(`${ROOT}/s1.ag_1.sent`)).toBe("1\n");
    expect(runLessonDrip(edit("/wt/web/b.ts", { agent_id: "ag/1" }), env, ROOT, d).out).toBe("");
    expect(ctx(runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d).out)).toContain("#1");
  });

  it("handles NotebookEdit, ignores other tools, sessions without an id and broken input", () => {
    const { d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web")]) });
    expect(ctx(runLessonDrip(JSON.stringify({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/wt/web/n.ipynb" } }), env, ROOT, d).out)).toContain("#1");
    expect(runLessonDrip(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/wt/web/a.ts" } }), env, ROOT, d).out).toBe("");
    expect(runLessonDrip(edit("/wt/web/a.ts"), {}, ROOT, d).out).toBe("");
    expect(runLessonDrip("not json", env, ROOT, d).out).toBe("");
    expect(runLessonDrip(edit("/wt/web/a.ts"), { SHIPHERD_SESSION: "nobody" }, ROOT, d).out).toBe("");
  });

  it("matches Windows paths without caring about case or slashes", () => {
    const m: DripManifest = { v: 1, lang: "zh", roots: [{ slug: "acme/web", dirs: ["C:\\wt\\web"] }], lessons: [] };
    expect(locate("c:\\WT\\web\\src\\A.ts", m, "win32")).toEqual({ slug: "acme/web", rel: "src/A.ts" });
    expect(locate("/wt/web2/a", { ...m, roots: [{ slug: "x", dirs: ["/wt/web"] }] }, "linux")).toBeNull();
    // 嵌套目录：最长的优先
    expect(locate("/a/b/c.ts", { ...m, roots: [{ slug: "outer", dirs: ["/a"] }, { slug: "inner", dirs: ["/a/b"] }] }, "linux")).toEqual({ slug: "inner", rel: "c.ts" });
    // . 和 .. 先展开：web 目录下的 ../api 是 api 仓库的文件。
    const two = { ...m, roots: [{ slug: "acme/web", dirs: ["/wt/web"] }, { slug: "acme/api", dirs: ["/wt/api/"] }] };
    expect(locate("/wt/web/../api/./src/a.ts", two, "linux")).toEqual({ slug: "acme/api", rel: "src/a.ts" });
    expect(locate("/wt/web/src/../../../etc/x", two, "linux")).toBeNull();
    expect(locate("C:\\wt\\web\\..\\api\\a.ts", { ...m, roots: [{ slug: "acme/api", dirs: ["c:\\wt\\api"] }] }, "win32")).toEqual({ slug: "acme/api", rel: "a.ts" });
  });
});

describe("concurrent edits in one session", () => {
  it("a second edit while the first is still writing stdout waits, then does not send the same lessons again", () => {
    const { f, d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web")]) });
    let slept = 0;
    const first = runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d);
    expect(ctx(first.out)).toContain("#1");
    // 第一个还没 commit：第二个拿不到锁，等一会儿；等的时候第一个送完了。
    const waiting: DripDeps = { ...d, sleep: () => void (slept++ === 0 && first.commit()) };
    expect(runLessonDrip(edit("/wt/web/b.ts"), env, ROOT, waiting).out).toBe("");
    expect(slept).toBe(1);
    expect(f.get(`${ROOT}/s1.sent`)).toBe("1\n");
    expect(f.has(`${ROOT}/s1.sent.lock`)).toBe(false);
  });

  it("gives up without marking anything when the lock never frees, so the next edit still sends", () => {
    const { f, d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web")]), [`${ROOT}/s1.sent.lock`]: "" });
    expect(runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d).out).toBe("");
    expect(f.has(`${ROOT}/s1.sent`)).toBe(false);
    f.delete(`${ROOT}/s1.sent.lock`);
    expect(ctx(runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d).out)).toContain("#1");
  });

  it("commit appends only ids nobody recorded meanwhile", () => {
    const { f, d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web"), lesson(2, "acme/web")]) });
    const run = runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d);
    f.set(`${ROOT}/s1.sent`, "2\n"); // 锁过期被抢的进程先记了 #2
    run.commit();
    expect(f.get(`${ROOT}/s1.sent`)).toBe("2\n1\n");
  });
});

describe("resetLessonDrip", () => {
  it("forgets what was sent so the next edit sends it again", () => {
    const { f, d } = fs({ [`${ROOT}/s1.json`]: manifest([lesson(1, "acme/web")]), [`${ROOT}/s1.sent`]: "1\n" });
    expect(runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d).out).toBe("");
    resetLessonDrip(env, ROOT, d);
    expect(f.has(`${ROOT}/s1.sent`)).toBe(false);
    expect(ctx(runLessonDrip(edit("/wt/web/a.ts"), env, ROOT, d).out)).toContain("#1");
  });
});

describe("hook commands", () => {
  it("only starts the hook when this session has a manifest", () => {
    expect(lessonsHookCommand('"/h"', "/d/x", "darwin")).toBe('[ ! -f "/d/x/${SHIPHERD_SESSION:-_}.json" ] || exec "/h" lessons "/d/x"');
    expect(lessonsHookCommand('"C:/h"', "C:\\d\\x", "win32")).toContain('"C:/d/x/${SHIPHERD_SESSION:-_}.json"');
    expect(lessonsResetCommand('"/h"', "/d/x", "linux")).toBe('[ -z "${SHIPHERD_SESSION:-}" ] || exec "/h" lessons-reset "/d/x"');
  });
});
