import { afterEach, describe, expect, it } from "vitest";
import { SettingsRepo } from "./db/settings-repo";
import { TicketsRepo } from "./db/tickets-repo";
import { setLang } from "./i18n";
import { normalizeBranchTemplate, SettingError } from "./settings/settings-values";
import { MAIN_STRINGS } from "./strings";
import { makeRepo, memDb, tempDir } from "./test-utils";
import { TicketError, TicketService } from "./tickets/ticket-service";
import { cleanupTicketWorktrees } from "./tickets/worktree-cleanup";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const shape = (o: Record<string, unknown>) => Object.keys(o).sort().map((k) => `${k}:${typeof o[k] === "function" ? `fn${(o[k] as () => void).length}` : typeof o[k]}`);

afterEach(() => setLang("zh"));

describe("main-process messages in two languages (design 2026-10-26 i18n)", () => {
  it("has the same keys and arities in both tables", () => {
    expect(shape(MAIN_STRINGS.en)).toEqual(shape(MAIN_STRINGS.zh));
  });

  it("throws English errors with the same codes when the language is English", async () => {
    const db = memDb();
    const service = new TicketService({ tickets: new TicketsRepo(db), settings: new SettingsRepo(db), now: () => 1, workspacesDir: tempDir() });
    setLang("en");
    const e = await service.create({ key: "not a key" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TicketError);
    expect(e).toMatchObject({ code: "invalid_key", message: "The ticket id is not in the expected format: not a key" });
    expect(() => normalizeBranchTemplate("x")).toThrow(new SettingError("The branch template must contain {key} or {key_lower}, for example feature/{key}"));
  });

  it("explains a blocked cleanup in English", async () => {
    const db = memDb();
    const tickets = new TicketsRepo(db);
    const ticketService = new TicketService({ tickets, settings: new SettingsRepo(db), now: () => 1, workspacesDir: tempDir() });
    const t = await ticketService.create({ key: "DMS-1", repoPath: makeRepo(), workMode: "worktree" });
    writeFileSync(join(t.repos[0].worktreePath!, "new.txt"), "x");
    setLang("en");
    const [out] = await cleanupTicketWorktrees({ tickets, ticketService, repoBusy: () => false, now: () => 1 }, "DMS-1");
    expect(out.reason).toBe("the worktree has uncommitted changes or untracked files");
  });
});
