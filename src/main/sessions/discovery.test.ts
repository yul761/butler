import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { DEFAULT_TICKET_PATTERN } from "../tickets/ticket-key";
import { memDb, tempDir } from "../test-utils";
import { extractUserText, findTranscript, needsDiscovery, readSessionHead, scanClaudeProjects, suggestTicket, syncDiscovered, transcriptState } from "./discovery";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

const lines = (...entries: unknown[]) => entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n";
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", cwd: "/work/app", gitBranch: "feature/proj-12-login", message: { role: "user", content }, ...extra });

describe("extractUserText", () => {
  it("accepts plain and text-block prompts, rejects meta/sidechain/command/tool results", () => {
    expect(extractUserText(user("修复登录"))).toBe("修复登录");
    expect(extractUserText(user([{ type: "text", text: "hello" }]))).toBe("hello");
    expect(extractUserText(user("<command-name>/clear</command-name>"))).toBeNull();
    expect(extractUserText(user("x", { isMeta: true }))).toBeNull();
    expect(extractUserText(user("x", { isSidechain: true }))).toBeNull();
    expect(extractUserText(user([{ type: "tool_result", content: "ok" }]))).toBeNull();
    expect(extractUserText({ type: "assistant" })).toBeNull();
    expect(extractUserText(user("a".repeat(300)))).toHaveLength(201);
  });

  it("keeps real prompts that merely start with an HTML-like tag", () => {
    expect(extractUserText(user("<div>修一下这个组件</div>"))).toBe("<div>修一下这个组件</div>");
  });
});

describe("readSessionHead", () => {
  it("skips junk lines and finds cwd, branch and first real prompt", async () => {
    const file = join(tempDir(), `${ID1}.jsonl`);
    writeFileSync(file, lines("{not json", 42, null, { type: "summary", summary: "x" }, user("<command-name>/x</command-name>"), user("真正的问题")));
    expect(await readSessionHead(file)).toEqual({ cwd: "/work/app", gitBranch: "feature/proj-12-login", firstPrompt: "真正的问题" });
  });

  it("settles promptly with an empty head when the file cannot be opened", async () => {
    const file = join(tempDir(), `${ID1}.jsonl`);
    const head = await readSessionHead(file);
    expect(head).toEqual({ cwd: null, gitBranch: null, firstPrompt: null });
  }, 2000);

  it("stops after maxLines", async () => {
    const file = join(tempDir(), `${ID1}.jsonl`);
    const filler = Array.from({ length: 50 }, () => ({ type: "summary", cwd: "/w" }));
    writeFileSync(file, lines(...filler, user("late")));
    expect((await readSessionHead(file, 10)).firstPrompt).toBeNull();
  });
});

describe("findTranscript", () => {
  it("finds a session's jsonl in any project dir, or returns null", () => {
    const root = tempDir();
    mkdirSync(join(root, "-work-a"));
    mkdirSync(join(root, "-work-b"));
    writeFileSync(join(root, "-work-b", `${ID1}.jsonl`), "{}\n");
    expect(findTranscript(root, ID1)).toBe(join(root, "-work-b", `${ID1}.jsonl`));
    expect(findTranscript(root, ID2)).toBeNull();
    expect(findTranscript(join(root, "missing"), ID1)).toBeNull();
  });
});

describe("transcriptState", () => {
  it("is present, absent, or unknown when the projects dir cannot be read", () => {
    const root = tempDir();
    mkdirSync(join(root, "-work-b"));
    writeFileSync(join(root, "-work-b", `${ID1}.jsonl`), "{}\n");
    expect(transcriptState(root, ID1)).toBe("present");
    expect(transcriptState(root, ID2)).toBe("absent");
    expect(transcriptState(join(root, "missing"), ID1)).toBe("absent");
    const notADir = join(root, "plain-file");
    writeFileSync(notADir, "x");
    expect(transcriptState(notADir, ID1)).toBe("unknown");
  });
});

describe("transcriptState with stray files", () => {
  it("skips a non-directory entry such as .DS_Store and still finds the transcript", () => {
    const root = tempDir();
    writeFileSync(join(root, ".DS_Store"), "x");
    mkdirSync(join(root, "-work-b"));
    writeFileSync(join(root, "-work-b", `${ID1}.jsonl`), "{}\n");
    expect(transcriptState(root, ID1)).toBe("present");
  });

  it("returns absent, not unknown, when a .DS_Store sits next to a project dir without the transcript", () => {
    const root = tempDir();
    writeFileSync(join(root, ".DS_Store"), "x");
    mkdirSync(join(root, "-work-b"));
    expect(transcriptState(root, ID1)).toBe("absent");
  });
});

describe("scanClaudeProjects", () => {
  it("returns recent uuid-named sessions with a cwd", async () => {
    const root = tempDir();
    const proj = join(root, "-work-app");
    mkdirSync(proj);
    writeFileSync(join(proj, `${ID1}.jsonl`), lines(user("recent")));
    writeFileSync(join(proj, `${ID2}.jsonl`), lines(user("old")));
    writeFileSync(join(proj, "not-a-uuid.jsonl"), lines(user("x")));
    writeFileSync(join(proj, "notes.txt"), "x");
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(join(proj, `${ID2}.jsonl`), old, old);

    const found = await scanClaudeProjects(root, Date.now() - 7 * 24 * 3600 * 1000);
    expect(found.map((f) => f.id)).toEqual([ID1]);
    expect(found[0]).toMatchObject({ cwd: "/work/app", firstPrompt: "recent" });
  });

  const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
  it.skipIf(!canChmod)("keeps valid sessions when another .jsonl is unreadable", async () => {
    const root = tempDir();
    const proj = join(root, "-work-app");
    mkdirSync(proj);
    writeFileSync(join(proj, `${ID1}.jsonl`), lines(user("ok")));
    const bad = join(proj, `${ID2}.jsonl`);
    writeFileSync(bad, lines(user("locked")));
    chmodSync(bad, 0o000);
    try {
      const found = await scanClaudeProjects(root, 0);
      expect(found.map((f) => f.id)).toEqual([ID1]);
    } finally {
      chmodSync(bad, 0o644);
    }
  });

  it("returns [] when the projects dir does not exist", async () => {
    expect(await scanClaudeProjects(join(tempDir(), "missing"), 0)).toEqual([]);
  });
});

describe("syncDiscovered / suggestTicket", () => {
  it("inserts new sessions without disturbing claimed ones", () => {
    const db = memDb();
    new TicketsRepo(db).insert({ key: "PROJ-12", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
    const sessions = new SessionsRepo(db);
    sessions.insertIfAbsent({ id: ID2, ticketKey: "PROJ-12", cwd: "/r", origin: "butler", lastActivityAt: 5, createdAt: 1 });
    const inserted = syncDiscovered(
      [
        { id: ID1, cwd: "/w", gitBranch: "main", firstPrompt: "hi", lastActivityAt: 10 },
        { id: ID2, cwd: "/other", gitBranch: "x", firstPrompt: "y", lastActivityAt: 20 },
      ],
      sessions, 100,
    );
    expect(inserted).toEqual([ID1]);
    expect(sessions.get(ID1)).toMatchObject({ origin: "discovered", ticketKey: null });
    expect(sessions.get(ID2)).toMatchObject({ ticketKey: "PROJ-12", cwd: "/r", origin: "butler", lastActivityAt: 20 });
  });

  it("suggests from branch first, then prompt", () => {
    expect(suggestTicket({ gitBranch: "feature/proj-12-x", firstPrompt: "PROJ-99" }, DEFAULT_TICKET_PATTERN)).toBe("PROJ-12");
    expect(suggestTicket({ gitBranch: "main", firstPrompt: "看下 PROJ-99" }, DEFAULT_TICKET_PATTERN)).toBe("PROJ-99");
    expect(suggestTicket({ gitBranch: null, firstPrompt: null }, DEFAULT_TICKET_PATTERN)).toBeNull();
  });
});

describe("needsDiscovery", () => {
  const base = {
    id: "a", ticketKey: null, cwd: "/w", origin: "discovered" as const, gitBranch: "main", firstPrompt: "hi",
    lastActivityAt: 1, waitingForInput: false, replacedBy: null, dismissed: false, createdAt: 1,
  };

  it("only asks for a scan when an unclaimed session is missing details, once per session", () => {
    expect(needsDiscovery(base, new Set())).toBe(false);
    expect(needsDiscovery({ ...base, gitBranch: null }, new Set())).toBe(true);
    expect(needsDiscovery({ ...base, cwd: "" }, new Set())).toBe(true);
    expect(needsDiscovery({ ...base, firstPrompt: null }, new Set(["a"]))).toBe(false);
    expect(needsDiscovery({ ...base, gitBranch: null, ticketKey: "PROJ-1" }, new Set())).toBe(false);
    expect(needsDiscovery({ ...base, gitBranch: null, dismissed: true }, new Set())).toBe(false);
  });
});
