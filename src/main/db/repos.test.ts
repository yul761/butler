import { describe, expect, it } from "vitest";
import type { Ticket } from "../../shared/types";
import { memDb } from "../test-utils";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";
import { SessionsRepo } from "./sessions-repo";
import { SettingsRepo } from "./settings-repo";
import { TicketsRepo } from "./tickets-repo";

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => ({
  key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: `feature/${key}`,
  status: "active", statusManual: null, createdAt: 1, archivedAt: null, ...over,
});

describe("migrate", () => {
  it("is idempotent", () => {
    const db = memDb();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MIGRATIONS.length);
  });
});

describe("TicketsRepo", () => {
  it("inserts, reads, lists without archived, sets manual status", () => {
    const repo = new TicketsRepo(memDb());
    repo.insert(ticket("PROJ-1", { title: "登录页" }));
    repo.insert(ticket("PROJ-2"));
    expect(repo.get("PROJ-1")?.title).toBe("登录页");
    expect(repo.get("NOPE-1")).toBeNull();
    repo.archive("PROJ-2", 5);
    expect(repo.list().map((t) => t.key)).toEqual(["PROJ-1"]);
    expect(repo.list({ includeArchived: true })).toHaveLength(2);
    repo.setStatusManual("PROJ-1", "blocked");
    expect(repo.get("PROJ-1")?.statusManual).toBe("blocked");
    repo.setStatusManual("PROJ-1", null);
    expect(repo.get("PROJ-1")?.statusManual).toBeNull();
  });
});

describe("SessionsRepo", () => {
  const setup = () => {
    const db = memDb();
    new TicketsRepo(db).insert(ticket("PROJ-1"));
    return new SessionsRepo(db);
  };

  it("insertIfAbsent only inserts once", () => {
    const repo = setup();
    expect(repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/x", origin: "discovered", createdAt: 1 })).toBe(true);
    expect(repo.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/y", origin: "butler", createdAt: 2 })).toBe(false);
    expect(repo.get("a")).toMatchObject({ ticketKey: null, cwd: "/x", origin: "discovered", waitingForInput: false, dismissed: false });
  });

  it("fillDetails keeps existing values and only moves lastActivityAt forward", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "", origin: "discovered", gitBranch: "main", lastActivityAt: 10, createdAt: 1 });
    repo.fillDetails("a", { cwd: "/x", gitBranch: "other", firstPrompt: "hi", lastActivityAt: 5 });
    expect(repo.get("a")).toMatchObject({ cwd: "/x", gitBranch: "main", firstPrompt: "hi", lastActivityAt: 10 });
    repo.fillDetails("a", { lastActivityAt: 20 });
    expect(repo.get("a")?.lastActivityAt).toBe(20);
    repo.fillDetails("a", { lastActivityAt: null });
    expect(repo.get("a")?.lastActivityAt).toBe(20);
  });

  it("head follows replacedBy and survives cycles", () => {
    const repo = setup();
    for (const id of ["a", "b", "c"]) repo.insertIfAbsent({ id, ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 1 });
    repo.setReplacedBy("a", "b");
    repo.setReplacedBy("b", "c");
    expect(repo.head("a")?.id).toBe("c");
    expect(repo.head("missing")).toBeNull();
    repo.setReplacedBy("c", "a");
    expect(repo.head("a")).not.toBeNull();
  });

  it("setOrigin and delete (clearing pointers to the deleted row)", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/x", origin: "discovered", createdAt: 1 });
    repo.insertIfAbsent({ id: "b", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 2 });
    repo.setOrigin("a", "butler");
    expect(repo.get("a")?.origin).toBe("butler");
    repo.setReplacedBy("a", "b");
    repo.delete("b");
    expect(repo.get("b")).toBeNull();
    expect(repo.get("a")?.replacedBy).toBeNull();
  });

  it("listUnclaimed excludes claimed, dismissed, replaced and old sessions", () => {
    const repo = setup();
    const add = (id: string, at: number, ticketKey: string | null = null) =>
      repo.insertIfAbsent({ id, ticketKey, cwd: "/x", origin: "discovered", lastActivityAt: at, createdAt: at });
    add("fresh", 100);
    add("old", 1);
    add("claimed", 100, "PROJ-1");
    add("dismissed", 100);
    repo.dismiss("dismissed");
    add("replaced", 100);
    repo.setReplacedBy("replaced", "fresh");
    expect(repo.listUnclaimed(50).map((s) => s.id)).toEqual(["fresh"]);
  });

  it("setWaiting sets the flag and bumps activity; listByTicket orders by recency", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", lastActivityAt: 1, createdAt: 1 });
    repo.insertIfAbsent({ id: "b", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", lastActivityAt: 2, createdAt: 1 });
    repo.setWaiting("a", true, 9);
    expect(repo.get("a")).toMatchObject({ waitingForInput: true, lastActivityAt: 9 });
    expect(repo.listByTicket("PROJ-1").map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("SettingsRepo", () => {
  it("returns defaults and stores overrides", () => {
    const repo = new SettingsRepo(memDb());
    expect(repo.get("branchTemplate")).toBe("feature/{key}");
    repo.set("branchTemplate", "yc/{key}");
    expect(repo.get("branchTemplate")).toBe("yc/{key}");
  });
});
