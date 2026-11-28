import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { GUIDE_SECTIONS, pruneSessionGuides, sessionGuide, writeSessionGuide } from "./session-guide";

describe("session guide", () => {
  it("包含 CI 那一段，中英各一份", () => {
    expect(sessionGuide("zh", "ticket")).toContain("不要循环查 CI");
    expect(sessionGuide("en", "coordinator")).toContain("Shipherd watches your PR and CI");
    expect(GUIDE_SECTIONS.length).toBeGreaterThan(0);
  });

  it("所有 session 都有子代理的模型准则，只有总控有 start_session 的", () => {
    expect(sessionGuide("zh", "ticket")).toContain('model: "opus"');
    expect(sessionGuide("zh", "coordinator")).toContain('model: "opus"');
    expect(sessionGuide("en", "ticket")).toContain('model: "opus"');
    expect(sessionGuide("zh", "coordinator")).toContain("start_session");
    expect(sessionGuide("en", "coordinator")).toContain("start_session");
    expect(sessionGuide("zh", "ticket")).not.toContain("start_session");
    expect(sessionGuide("en", "ticket")).not.toContain("start_session");
  });

  it("epic 总控有 epic 里 feature 的说明（BTL-246）：按顺序推进、约定写进 epic 记忆；别的 session 没有", () => {
    for (const lang of ["zh", "en"] as const) {
      const g = sessionGuide(lang, "coordinator");
      for (const w of ["list_features", "create_feature", "set_ticket_feature", "reorder_features", "shipherd-feature", "shipherd-memory"]) expect(g, w).toContain(w);
      for (const kind of ["ticket", "shipherd", "lessons"] as const) expect(sessionGuide(lang, kind)).not.toContain("set_ticket_feature");
    }
  });

  it("feature 总控和 Shipherd 总控有栈的说明（工作流 K），stack_on 只给 feature 总控", () => {
    for (const lang of ["zh", "en"] as const) {
      expect(sessionGuide(lang, "coordinator")).toContain("stack_on");
      expect(sessionGuide(lang, "shipherd")).toContain("stack_define");
      expect(sessionGuide(lang, "shipherd")).not.toContain("stack_on");
      for (const kind of ["ticket", "lessons"] as const) expect(sessionGuide(lang, kind)).not.toContain("stack_define");
    }
  });

  it("tells both coordinators that stack_rebase on needs_confirm confirms the rewrite: ask the user first (BTL-278)", () => {
    for (const lang of ["zh", "en"] as const) {
      for (const kind of ["coordinator", "shipherd"] as const) expect(sessionGuide(lang, kind)).toMatch(/needs_confirm[^。.]*ask_user|needs_confirm[\s\S]{0,120}ask_user/);
    }
  });

  it("只有 ticket session 被告知自我 review 之后用 report 说明结果（PR 进度时间线）", () => {
    expect(sessionGuide("zh", "ticket")).toContain("自我 review");
    expect(sessionGuide("zh", "ticket")).toContain("进度时间线");
    expect(sessionGuide("en", "ticket")).toContain("progress timeline");
    expect(sessionGuide("en", "ticket")).toContain("self-review");
    for (const kind of ["coordinator", "shipherd"] as const) {
      expect(sessionGuide("zh", kind)).not.toContain("自我 review");
      expect(sessionGuide("en", kind)).not.toContain("self-review");
    }
  });

  it("所有 session 都被告知上下文会被换新，并要 remember 重要决定", () => {
    for (const kind of ["ticket", "coordinator"] as const) {
      expect(sessionGuide("zh", kind)).toContain("再让你从记忆里接上");
      expect(sessionGuide("zh", kind)).toContain("remember");
      expect(sessionGuide("en", kind)).toContain("refresh a session whose context grows too long");
    }
  });

  it("所有 session 都知道 ask_user 和 report，只有总控被告知不要转述子 session 的问题（BTL-190 第 2+3 点）", () => {
    for (const kind of ["ticket", "coordinator"] as const) {
      expect(sessionGuide("zh", kind)).toContain("ask_user");
      expect(sessionGuide("zh", kind)).toContain("结束这一轮");
      expect(sessionGuide("zh", kind)).toContain("要我继续吗");
      expect(sessionGuide("en", kind)).toContain("report (kind done or blocked)");
    }
    expect(sessionGuide("zh", "coordinator")).toContain("不用你再转述");
    expect(sessionGuide("en", "coordinator")).toContain("do not ask them again");
    expect(sessionGuide("zh", "ticket")).not.toContain("不用你再转述");
  });

  it("全局总控知道自己只看不建，跨 epic 协调用 send_message（BTL-190 第 5 点，BTL-246）", () => {
    const zh = sessionGuide("zh", "shipherd");
    expect(zh).toContain("全局总控");
    expect(zh).toContain("send_message");
    expect(zh).toContain("不能建");
    // BTL-246：一个 epic 有一个总控，epic 里的 feature 只是一组 ticket。
    expect(zh).toContain("list_epics");
    expect(zh).toContain("list_features");
    expect(zh).toContain("refresh_epic_summary");
    expect(zh).not.toContain("refresh_feature_summary");
    expect(zh).toContain("ask_user");
    expect(zh).toContain("再让你从记忆里接上");
    // 它不 push，也不开子 session。
    expect(zh).not.toContain("不要循环查 CI");
    expect(zh).not.toContain("start_session");
    expect(zh).not.toContain("start_feature");
    const en = sessionGuide("en", "shipherd");
    expect(en).toContain("global control");
    expect(en).toContain("send_message");
    expect(en).toContain("cannot create");
    expect(en).toContain("list_epics");
    expect(en).not.toContain("refresh_feature_summary");
    expect(/[\u4e00-\u9fff]/.test(en)).toBe(false);
    for (const kind of ["ticket", "coordinator"] as const) expect(sessionGuide("zh", kind)).not.toContain("全局总控");
  });

  it("复盘分析 session 没有 Shipherd 的工具：不提 ask_user、report、记忆和 CI，只留子代理的模型准则（lessons visibility task 7）", () => {
    for (const lang of ["zh", "en"] as const) {
      const g = sessionGuide(lang, "lessons");
      expect(g).toContain('model: "opus"');
      for (const word of ["ask_user", "report", "remember", "send_message", "start_session", "CI"]) expect(g, word).not.toContain(word);
    }
    expect(/[\u4e00-\u9fff]/.test(sessionGuide("en", "lessons"))).toBe(false);
  });

  it("写到 mcp 目录，内容没变就不重写", () => {
    const dir = tempDir("guide");
    const file = writeSessionGuide(dir, "zh", "ticket");
    expect(file).toBe(join(dir, "guide-ticket-zh.md"));
    expect(readFileSync(file, "utf8")).toBe(sessionGuide("zh", "ticket"));
    const old = new Date(2020, 0, 1);
    utimesSync(file, old, old);
    expect(writeSessionGuide(dir, "zh", "ticket")).toBe(file);
    expect(statSync(file).mtimeMs).toBe(old.getTime());
  });
  describe("lessons", () => {
    const lessons = [{ label: "acme/web", text: "改 schema 要加迁移" }];

    it("puts lessons in ticket guides only", () => {
      const zh = sessionGuide("zh", "ticket", lessons);
      expect(zh).toContain("逐条对照");
      expect(zh).toContain("- [acme/web] 改 schema 要加迁移");
      expect(sessionGuide("en", "ticket", [{ label: "a/b", text: "x" }])).toContain("- [a/b] x");
      expect(/[\u4e00-\u9fff]/.test(sessionGuide("en", "ticket", [{ label: "a/b", text: "x" }]))).toBe(false);
      for (const kind of ["coordinator", "shipherd"] as const) expect(sessionGuide("zh", kind, lessons)).not.toContain("acme/web");
      expect(sessionGuide("zh", "ticket", [])).toBe(sessionGuide("zh", "ticket"));
    });

    it("writes a content-hashed file when there are lessons", () => {
      const dir = tempDir("guide");
      const file = writeSessionGuide(dir, "zh", "ticket", lessons);
      expect(file).toMatch(/guide-ticket-zh-[0-9a-f]{12}\.md$/);
      expect(readFileSync(file, "utf8")).toBe(sessionGuide("zh", "ticket", lessons));
      expect(writeSessionGuide(dir, "zh", "ticket", lessons)).toBe(file);
      expect(writeSessionGuide(dir, "zh", "ticket", [{ label: "acme/web", text: "别的" }])).not.toBe(file);
      expect(writeSessionGuide(dir, "zh", "ticket", [])).toBe(join(dir, "guide-ticket-zh.md"));
    });

    it("prunes hashed guides older than 30 days only", () => {
      const dir = tempDir("guide");
      const now = Date.now();
      const day = 86400_000;
      const mk = (name: string, ageDays: number) => {
        const f = join(dir, name);
        writeFileSync(f, "x");
        const t = new Date(now - ageDays * day);
        utimesSync(f, t, t);
        return f;
      };
      const old = mk("guide-ticket-zh-0123456789ab.md", 31);
      const fresh = mk("guide-ticket-en-0123456789ab.md", 1);
      const plain = mk("guide-ticket-zh.md", 90);
      const other = mk("guide-ticket-zh-xyz.md", 90);
      expect(pruneSessionGuides(dir, now)).toBe(1);
      expect(existsSync(old)).toBe(false);
      for (const f of [fresh, plain, other]) expect(existsSync(f)).toBe(true);
      expect(pruneSessionGuides(join(dir, "missing"), now)).toBe(0);
    });
  });
});

describe("repo profile", () => {
  const profile = "Repo a/web (scanned 2026-11-18; the repo's own commands):\n- all tests: `pnpm test`";
  it("goes into ticket guides only, after the lessons", () => {
    const t = sessionGuide("en", "ticket", [{ label: "a/web", text: "keep it small" }], { profile });
    expect(t).toContain("use the repo's own commands");
    expect(t.indexOf("`pnpm test`")).toBeGreaterThan(t.indexOf("keep it small"));
    expect(sessionGuide("en", "coordinator", [], { profile })).not.toContain("pnpm test");
    expect(sessionGuide("zh", "ticket", [], { profile })).toContain("优先用这些仓库自己的命令");
  });
  it("is part of the hashed file name", () => {
    const dir = tempDir();
    const plain = writeSessionGuide(dir, "en", "ticket");
    const a = writeSessionGuide(dir, "en", "ticket", [], { profile });
    const b = writeSessionGuide(dir, "en", "ticket", [], { profile: `${profile}\n- lint: \`pnpm lint\`` });
    expect(a).not.toBe(plain);
    expect(a).not.toBe(b);
    expect(readFileSync(b, "utf8")).toContain("pnpm lint");
    expect(writeSessionGuide(dir, "en", "coordinator", [], { profile })).toBe(writeSessionGuide(dir, "en", "coordinator"));
  });
});

describe("session guide: principles and pre-review (workstream D)", () => {
  it("writes principle lines with a case count and the cases into a sibling file", () => {
    const dir = tempDir();
    const lessons = [{ label: "acme/web", text: "Never swallow errors", cases: ["log errors", "rethrow errors"] }, { label: "acme/web", text: "use tabs" }];
    const file = writeSessionGuide(dir, "en", "ticket", lessons);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("- [acme/web] Never swallow errors (2 cases)");
    expect(text).toContain("- [acme/web] use tabs");
    const cases = /read its cases .* in (\S+lessons-cases-[0-9a-f]{12}\.md)\./.exec(text)?.[1];
    expect(cases).toBeDefined();
    expect(readFileSync(cases!, "utf8")).toContain("## [acme/web] Never swallow errors\n- log errors\n- rethrow errors");
    expect(text).not.toContain("pre-review");
  });

  it("mentions the pre-review only when one is active", () => {
    expect(sessionGuide("en", "ticket", [{ label: "r", text: "t" }], { preReview: true })).toContain("A pre-review runs automatically before a PR is opened");
    expect(sessionGuide("zh", "ticket", [{ label: "r", text: "t" }], { preReview: false })).not.toContain("预审");
  });

  it("prunes old cases files with the guides", () => {
    const dir = tempDir();
    const f = join(dir, "lessons-cases-0123456789ab.md");
    writeFileSync(f, "x");
    utimesSync(f, 1, 1);
    expect(pruneSessionGuides(dir, Date.now())).toBe(1);
    expect(existsSync(f)).toBe(false);
  });

  it("a guide and cases file reused unchanged count as fresh, so pruning keeps them", () => {
    const dir = tempDir();
    const lessons = [{ label: "acme/web", text: "P", cases: ["a", "b", "c"] }];
    const file = writeSessionGuide(dir, "en", "ticket", lessons);
    const cases = /in (\S+lessons-cases-[0-9a-f]{12}\.md)\./.exec(readFileSync(file, "utf8"))![1];
    for (const f of [file, cases]) utimesSync(f, 1, 1);
    expect(writeSessionGuide(dir, "en", "ticket", lessons)).toBe(file);
    expect(pruneSessionGuides(dir, Date.now())).toBe(0);
    for (const f of [file, cases]) expect(existsSync(f)).toBe(true);
  });
});

describe("session guide: the lessons index (BTL-274)", () => {
  const index = {
    rows: [{ id: 7, label: "acme/web", title: "Re-read in the write transaction", globs: ["src/main/**"], lang: "ts" }, { id: 9, label: "shop", title: "Name things plainly", globs: [], lang: null }],
    more: 3,
    rest: [
      { id: 7, label: "acme/web", text: "Re-read in the write transaction. Fill only empty fields.", why: "a race lost edits", globs: ["src/main/**"], lang: "ts" },
      { id: 9, label: "shop", text: "Name things plainly.", why: "", globs: [], lang: null },
    ],
  };

  it("lists the lessons that did not fit by id, title and scope, and says to look them up before touching that scope", () => {
    for (const lang of ["zh", "en"] as const) {
      const dir = tempDir();
      const text = readFileSync(writeSessionGuide(dir, lang, "ticket", [{ id: 1, label: "acme/web", text: "use tabs" }], { index, lessonsTool: true, drip: true }), "utf8");
      expect(text).toContain("- [acme/web] use tabs");
      expect(text).toContain(lang === "zh" ? "- #7 [acme/web] Re-read in the write transaction（范围：src/main/** · ts）" : "- #7 [acme/web] Re-read in the write transaction (scope: src/main/** · ts)");
      expect(text).toContain(lang === "zh" ? "- #9 [shop] Name things plainly（整个仓库）" : "- #9 [shop] Name things plainly (whole repo)");
      expect(text).toContain(lang === "zh" ? "还有 5 条规矩" : "5 more rules");
      expect(text).toContain(lang === "zh" ? "用 lessons 工具查" : "lessons tool");
      expect(text).toContain(lang === "zh" ? "- 还有 3 条" : "- 3 more");
      expect(text).toContain(lang === "zh" ? "补送" : "Shipherd also sends the full text");
      const rest = /(\S+lessons-rest-[0-9a-f]{12}\.md)/.exec(text)?.[1];
      expect(rest).toBeDefined();
      const body = readFileSync(rest!, "utf8");
      expect(body).toContain("Re-read in the write transaction. Fill only empty fields.");
      expect(body).toContain("#9 [shop]");
    }
  });

  it("writes the section even when no lesson fits in full, and leaves out the tool and the drip when the session has neither", () => {
    const text = sessionGuide("en", "ticket", [], { index, restFile: "/x/lessons-rest-0123456789ab.md" });
    expect(text).toContain("- #7 [acme/web]");
    expect(text).toContain("matching scope, read /x/lessons-rest-0123456789ab.md to get");
    expect(text).not.toContain("lessons tool");
    expect(text).not.toContain("Shipherd also sends");
    expect(sessionGuide("en", "coordinator", [], { index })).not.toContain("#7");
  });

  it("prunes old rest files with the guides", () => {
    const dir = tempDir();
    const f = join(dir, "lessons-rest-0123456789ab.md");
    writeFileSync(f, "x");
    utimesSync(f, 1, 1);
    expect(pruneSessionGuides(dir, Date.now())).toBe(1);
  });
});
