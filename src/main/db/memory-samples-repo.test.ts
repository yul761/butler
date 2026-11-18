import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { MemorySamplesRepo } from "./memory-samples-repo";
import { SessionsRepo } from "./sessions-repo";

describe("MemorySamplesRepo (WS-M A)", () => {
  it("stores, reads back by time and kind, and prunes old rows", () => {
    const repo = new MemorySamplesRepo(memDb());
    repo.insertMany([
      { at: 1, kind: "session", sessionId: "a", totalKb: 10.4, detail: { claude: 8, mcp_butler: 2 } },
      { at: 1, kind: "butler", sessionId: null, totalKb: 5, detail: null },
      { at: 2, kind: "system", sessionId: null, totalKb: 700, detail: { totalKb: 1000 } },
    ]);
    expect(repo.since(0).map((r) => r.kind)).toEqual(["session", "butler", "system"]);
    expect(repo.since(0, "session")).toEqual([{ at: 1, kind: "session", sessionId: "a", totalKb: 10, detail: { claude: 8, mcp_butler: 2 } }]);
    expect(repo.since(2).length).toBe(1);
    expect(repo.prune(2)).toBe(2);
    expect(repo.since(0).length).toBe(1);
  });

  it("keeps the latest memory on the session row", () => {
    const sessions = new SessionsRepo(memDb());
    sessions.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1 });
    expect(sessions.get("a")?.memKb).toBeNull();
    sessions.setMemory("a", 1234.6, 99);
    expect(sessions.get("a")).toMatchObject({ memKb: 1235, memAt: 99 });
  });
});
