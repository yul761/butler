import { afterEach, describe, expect, it } from "vitest";
import type { Handoff } from "../../shared/handoff";
import { BriefsRepo } from "../db/briefs-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { MarksRepo } from "../db/marks-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { chatReply, gatewayHarness, type GatewayHarness } from "../gateway/testing";
import { ingestHandoff } from "../handoff/ingest";
import { emptyHandoff } from "../handoff/schema";
import { insertTicket, memDb } from "../test-utils";
import { BriefService } from "./brief-service";
import { narrateBrief } from "./narrate";

const at = (d: number, h = 9) => new Date(2026, 9, d, h).getTime();
let h: GatewayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function world() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const briefs = new BriefsRepo(db);
  let fid = 0;
  const ingest = (key: string, sid: string | null, over: Partial<Handoff>) =>
    ingestHandoff(
      { db, tickets, handoffs, followups, now: () => at(20, 17), newFollowupId: () => `f${++fid}` },
      { ticketKey: key, sessionId: sid, trigger: "nightly", rawText: null, payload: { ...emptyHandoff(key), ...over } },
    );
  const service = new BriefService({
    tickets, sessions, handoffs, followups, marks: new MarksRepo(db), briefs, settings: new SettingsRepo(db), now: () => at(21), unclaimedCount: () => 0,
  });
  insertTicket(tickets, {
    key: "PAY-12", title: "Stripe payout reconciliation", repoPath: "/Users/me/code/billing-svc", workMode: "branch", worktreePath: null,
    branch: "feature/payments-v2", status: "active", statusManual: null, createdAt: at(1), archivedAt: null,
  });
  sessions.insertIfAbsent({ id: "s1", ticketKey: "PAY-12", cwd: "/x/packages/web", origin: "discovered", gitBranch: "main", lastActivityAt: at(20), createdAt: at(1) });
  insertTicket(tickets, {
    key: "OLD-9", title: null, repoPath: "/Users/me/code/ledger", workMode: "branch", worktreePath: null, branch: "old9",
    status: "done", statusManual: null, createdAt: at(1), archivedAt: null,
  });
  ingest("OLD-9", null, { status: "done", pr: { number: 3, url: "https://github.com/acme-corp/ledger-api/pull/3", state: "merged", review: "approved" } });
  tickets.archive("OLD-9", at(5));
  ingest("PAY-12", "s1", {
    status: "active",
    jira: { status: "In Progress", subtasks: [{ key: "PAY-77", status: "To Do" }] },
    next_steps: [
      "等 pay-77 子任务完成后在 payments-v2 上继续",
      "参考 acme-corp 在 ledger-api 里 old-9 的做法",
      "Stripe payout reconciliation 的结果再看一遍，maintain the webhook",
    ],
  });
  return { service, briefs };
}

describe("narrativeSource identifiers", () => {
  it("registers subtask keys, PR orgs of archived tickets, branch tails, titles; skips generic names", () => {
    const { service } = world();
    const { known } = service.narrativeSource(service.generateMorning());
    expect(known.tickets).toEqual(expect.arrayContaining(["PAY-12", "OLD-9", "PAY-77"]));
    expect(known.repos).toEqual(expect.arrayContaining(["acme-corp", "ledger-api", "billing-svc", "ledger"]));
    expect(known.branches).toEqual(expect.arrayContaining(["feature/payments-v2", "payments-v2"]));
    expect(known.terms).toContain("Stripe payout reconciliation");
    for (const generic of ["web", "main", "packages"]) {
      expect([...known.repos, ...known.branches]).not.toContain(generic);
    }
  });

  it("sends none of those values to the provider at redacted", async () => {
    const w = world();
    const brief = w.service.generateMorning();
    h = await gatewayHarness({ level: "redacted" });
    h.provider.handle(() => chatReply(JSON.stringify({ focus: ["先处理。"] })));
    const status = await narrateBrief({ narrate: (s, sig) => h!.gateway.narrate(s, sig), briefs: w.briefs, source: (b) => w.service.narrativeSource(b) }, brief);
    expect(status).toBe("ok");
    const body = h.bodies().join("\n").toLowerCase();
    expect(body).not.toBe("");
    for (const v of ["pay-77", "payments-v2", "acme-corp", "ledger-api", "old-9", "stripe payout", "billing-svc", "pay-12"]) {
      expect(body, v).not.toContain(v);
    }
  });
});
