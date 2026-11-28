import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ticket } from "../../shared/types";
import { stackTicketLive } from "./stack-service";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const indexSource = readFileSync(join(root, "src", "main", "index.ts"), "utf8");

/** index.ts 里从 start 开始到同一缩进的结束符为止的那一段。 */
function block(start: string, close: string): string {
  const from = indexSource.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const end = indexSource.indexOf(close, from);
  expect(end, start).toBeGreaterThan(from);
  return indexSource.slice(from, end);
}

const ticket = (o: Partial<Pick<Ticket, "archivedAt" | "status" | "statusManual">>) =>
  ({ archivedAt: null, status: "active", statusManual: null, ...o }) as Pick<Ticket, "archivedAt" | "status" | "statusManual">;

describe("which tickets the stack service works for (BTL-278 review)", () => {
  it("not archived and not closed", () => {
    expect(stackTicketLive(ticket({}))).toBe(true);
    expect(stackTicketLive(ticket({ statusManual: "done" }))).toBe(true);
    expect(stackTicketLive(ticket({ status: "needs_decision" }))).toBe(true);
    expect(stackTicketLive(ticket({ archivedAt: 1 }))).toBe(false);
    expect(stackTicketLive(ticket({ statusManual: "closed" }))).toBe(false);
    expect(stackTicketLive(null)).toBe(false);
  });

  it("index.ts goes by it when telling Shipherd branches and the repositories to detect stacks in", () => {
    const owned = block("const stackOwned = ", "\n  };");
    expect(owned).toContain("stackTicketLive(tickets.get(r.ticketKey))");
    expect(owned).not.toMatch(/archivedAt === null/);
    const auto = block("autoRebaseRepos: () =>", "\n    ],");
    expect(auto).toContain("stackTicketLive(t)");
    expect(auto).not.toMatch(/archivedAt === null/);
  });
});

describe("repository slugs are read with the async git only (BTL-270/278 review)", () => {
  it("the stack service and closing a ticket use slugOfAsync, never the sync slugOf", () => {
    const stack = block("const stackService = new StackService({", "\n  });");
    expect(stack).toContain("slugOf: (path) => repoIdentity.slugOfAsync(path)");
    const close = block("...closeWiring({", "\n    }),");
    expect(close).toContain("slugOf: (path) => repoIdentity.slugOfAsync(path)");
    for (const b of [stack, close]) expect(b).not.toMatch(/repoIdentity\.(slugOf|rawSlugOf|remoteSlugsOf)\(/);
  });
});
