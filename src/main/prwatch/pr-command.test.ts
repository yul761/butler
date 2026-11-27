import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import type { TicketPr } from "../db/ticket-prs-repo";
import { prStateFromEnvelope, ticketsForPrCommands, type PrCommandDeps, type PrStateSeen } from "./pr-command";

const row = (ticketKey: string, slug: string, number: number, headBranch = `${ticketKey}-b`): TicketPr =>
  ({ ticketKey, slug, number, url: `https://github.com/${slug}/pull/${number}`, headBranch } as TicketPr);

// 同一个 epic 的两个 ticket 在两个仓库里，PR 号码一样（#12），分支名也一样。
const ROWS = [row("A-1", "o/app", 12, "feat"), row("A-2", "o/api", 12, "feat"), row("B-1", "o/app", 30)];
const deps = (sessions: Record<string, { ticketKey: string | null; featureId: number | null }> = {}): PrCommandDeps => ({
  session: (id) => sessions[id] ?? null,
  ticketsOfFeature: (f) => (f === 1 ? ["A-1", "A-2"] : ["B-1"]),
  prsByUrl: (u) => ROWS.filter((r) => r.url === u),
  prsByNumber: (n) => ROWS.filter((r) => r.number === n),
  prsOfTicket: (k) => ROWS.filter((r) => r.ticketKey === k),
});
const seen = (o: Partial<PrStateSeen> & { commands: PrStateSeen["commands"] }): PrStateSeen => ({ sessionId: null, ticket: null, ...o });
const cmd = (pr: string | null, repo: string | null = null, action: "close" | "merge" | "reopen" = "close") => ({ action, dir: null, pr, repo });

describe("prStateFromEnvelope (BTL-270)", () => {
  const env = (payload: object, o: Partial<HookEnvelope> = {}): HookEnvelope => ({ v: 1, receivedAt: 1, ticket: null, shipherdSession: "s1", payload, ...o }) as HookEnvelope;
  it("takes the parsed commands from the hook, or parses the command of an older hook", () => {
    const base = { hook_event_name: "PostToolUse", tool_name: "Bash", session_id: "c1" };
    expect(prStateFromEnvelope(env({ ...base, pr_state: [cmd("12")] }, { ticket: "A-1" }))).toEqual({ sessionId: "s1", ticket: "A-1", commands: [cmd("12")] });
    expect(prStateFromEnvelope(env({ ...base, tool_input: { command: "gh pr reopen 12 -R o/app" } }))?.commands).toEqual([cmd("12", "o/app", "reopen")]);
    expect(prStateFromEnvelope(env({ ...base, tool_input: { command: "gh pr view 12" } }))).toBeNull();
    expect(prStateFromEnvelope(env({ hook_event_name: "Stop" }))).toBeNull();
  });
});

describe("ticketsForPrCommands (BTL-270)", () => {
  it("a PR link names its repo: only that ticket", () => {
    expect(ticketsForPrCommands(seen({ commands: [cmd("https://github.com/o/api/pull/12")] }), deps())).toEqual(["A-2"]);
  });

  it("a number with a repo matches only the PR in that repo, even when another repo of the same epic has the same number", () => {
    const d = deps({ coord: { ticketKey: null, featureId: 1 } });
    expect(ticketsForPrCommands(seen({ sessionId: "coord", commands: [cmd("12", "o/api")] }), d)).toEqual(["A-2"]);
    expect(ticketsForPrCommands(seen({ sessionId: "coord", commands: [cmd("#12", "O/App")] }), d)).toEqual(["A-1"]);
  });

  it("a ticket session's bare number or current branch is its own ticket, not the same number in another repo", () => {
    const d = deps({ s1: { ticketKey: "A-1", featureId: 1 } });
    expect(ticketsForPrCommands(seen({ sessionId: "s1", commands: [cmd("12")] }), d)).toEqual(["A-1"]);
    expect(ticketsForPrCommands(seen({ ticket: "A-2", commands: [cmd(null)] }), d)).toEqual(["A-2"]);
    // 还没收录的 PR：照样重读自己的 ticket。
    expect(ticketsForPrCommands(seen({ ticket: "A-1", commands: [cmd("99")] }), d)).toEqual(["A-1"]);
  });

  it("a coordinator's bare number stays inside its epic; the Shipherd coordinator's bare number is not guessed", () => {
    const d = deps({ coord: { ticketKey: null, featureId: 1 }, top: { ticketKey: null, featureId: null } });
    expect(ticketsForPrCommands(seen({ sessionId: "coord", commands: [cmd("12")] }), d).sort()).toEqual(["A-1", "A-2"]);
    expect(ticketsForPrCommands(seen({ sessionId: "coord", commands: [cmd("30")] }), d)).toEqual([]);
    expect(ticketsForPrCommands(seen({ sessionId: "top", commands: [cmd("12")] }), d)).toEqual([]);
    expect(ticketsForPrCommands(seen({ sessionId: "top", commands: [cmd("30", "o/app")] }), d)).toEqual(["B-1"]);
  });

  it("a coordinator's branch name matches its epic's PRs on that branch, with the repo when given", () => {
    const d = deps({ coord: { ticketKey: null, featureId: 1 } });
    expect(ticketsForPrCommands(seen({ sessionId: "coord", commands: [cmd("feat", "o/app")] }), d)).toEqual(["A-1"]);
    expect(ticketsForPrCommands(seen({ sessionId: "coord", commands: [cmd(null)] }), d)).toEqual([]);
  });
});
