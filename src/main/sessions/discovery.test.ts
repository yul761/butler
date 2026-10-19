import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { DEFAULT_TICKET_PATTERN } from "../tickets/ticket-key";
import { memDb, tempDir } from "../test-utils";
import { extractUserText, readSessionHead, scanClaudeProjects, suggestTicket, syncDiscovered } from "./discovery";

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
});

describe("readSessionHead", () => {
  it("skips junk lines and finds cwd, branch and first real prompt", async () => {
    const file = join(tempDir(), `${ID1}.jsonl`);
    writeFileSync(file, lines("{not json", 42, null, { type: "summary", summary: "x" }, user("<command-name>/x</command-name>"), user("真正的问题")));
    expect(await readSessionHead(file)).toEqual({ cwd: "/work/app", gitBranch: "feature/proj-12-login", firstPrompt: "真正的问题" });
  });

  it("stops after maxLines", async () => {
    const file = join(tempDir(), `${ID1}.jsonl`);
    const filler = Array.from({ length: 50 }, () => ({ type: "summary", cwd: "/w" }));
    writeFileSync(file, lines(...filler, user("late")));
    expect((await readSessionHead(file, 10)).firstPrompt).toBeNull();
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
