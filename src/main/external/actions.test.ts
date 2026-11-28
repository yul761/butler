import { describe, expect, it } from "vitest";
import { EXTERNAL_ACTION_SETTINGS } from "../../shared/external";
import { EDITABLE_SETTINGS } from "../../shared/settings";
import { ExternalAuditRepo } from "../db/external-audit-repo";
import { SETTING_DEFAULTS, SettingsRepo } from "../db/settings-repo";
import { normalizeSetting } from "../settings/settings-values";
import { memDb } from "../test-utils";
import { EXTERNAL_ACTIONS, ExternalActions, type ExternalScope } from "./actions";

function setup(o: { layered?: (key: string, scope: ExternalScope) => string | undefined; cutoff?: (now: number) => number } = {}) {
  const db = memDb();
  const settings = new SettingsRepo(db);
  const repo = new ExternalAuditRepo(db);
  let now = 10_000;
  const actions = new ExternalActions({ repo, setting: (k) => settings.get(k), now: () => now, ...o });
  return { settings, repo, actions, setNow: (t: number) => (now = t) };
}

describe("external action settings (contract 4.8)", () => {
  it("has one editable flag per kind, off by default", () => {
    expect(EXTERNAL_ACTIONS).toHaveLength(15);
    expect(EXTERNAL_ACTION_SETTINGS.branch_push).toBe("externalBranchPush");
    for (const kind of EXTERNAL_ACTIONS) {
      const key = EXTERNAL_ACTION_SETTINGS[kind];
      expect(EDITABLE_SETTINGS).toContain(key);
      expect(SETTING_DEFAULTS[key]).toBe("0");
      expect(normalizeSetting(key, " 1 ")).toBe("1");
      expect(() => normalizeSetting(key, "yes")).toThrow();
    }
    expect(new Set(Object.values(EXTERNAL_ACTION_SETTINGS)).size).toBe(15);
  });
});

describe("ExternalActions", () => {
  it("allows a kind only when its own flag is on", () => {
    const { settings, actions } = setup();
    for (const kind of EXTERNAL_ACTIONS) expect(actions.allowed(kind)).toBe(false);
    settings.set("externalCiRerun", "1");
    expect(actions.allowed("ci_rerun")).toBe(true);
    expect(actions.allowed("force_push")).toBe(false);
  });

  it("lets an injected layered resolver override the global flag for a scope", () => {
    const { actions } = setup({ layered: (key, scope) => (key === "externalPrLabel" && scope.repoSlug === "o/a" ? "1" : scope.repoSlug === "o/b" ? "0" : undefined) });
    expect(actions.allowed("pr_label", { repoSlug: "o/a" })).toBe(true);
    expect(actions.allowed("pr_label", { repoSlug: "o/c" })).toBe(false);
    expect(actions.allowed("pr_label")).toBe(false);
  });

  it("falls back to the global flag when the layered resolver throws", () => {
    const { settings, actions } = setup({ layered: () => { throw new Error("boom"); } });
    settings.set("externalIssuePost", "1");
    expect(actions.allowed("issue_post", { ticketKey: "T-1" })).toBe(true);
  });

  it("attempt skips and records when off, runs and records when on, and records failures", async () => {
    const { settings, actions, repo } = setup();
    let runs = 0;
    const run = async () => (++runs, "ok");
    const detail = { scope: { repoSlug: "o/a", ticketKey: "T-1" }, target: "https://x/pull/1#c1", summary: "reply to review", payload: "thanks" };
    expect(await actions.attempt("comment_reply", detail, run)).toMatchObject({ ran: false });
    expect(runs).toBe(0);
    settings.set("externalCommentReply", "1");
    expect(await actions.attempt("comment_reply", detail, run)).toMatchObject({ ran: true, value: "ok" });
    await expect(actions.attempt("comment_reply", detail, () => Promise.reject(new Error("403")))).rejects.toThrow("403");
    const list = repo.list();
    expect(list.map((e) => [e.outcome, e.error])).toEqual([["failed", "403"], ["done", null], ["skipped", null]]);
    expect(list[2]).toMatchObject({ kind: "comment_reply", repoSlug: "o/a", ticketKey: "T-1", target: "https://x/pull/1#c1", summary: "reply to review", payload: "thanks", ts: 10_000 });
  });

  it("prunes old rows by the retention cutoff at most once an hour", () => {
    const { actions, repo, setNow } = setup({ cutoff: (now) => now - 1000 });
    repo.insert({ ts: 1, kind: "pr_open", repoSlug: null, ticketKey: null, target: null, summary: "old", payload: null, outcome: "skipped", error: null });
    actions.record("pr_open", { summary: "new", outcome: "skipped" });
    expect(repo.list().map((e) => e.summary)).toEqual(["new"]);
    repo.insert({ ts: 2, kind: "pr_open", repoSlug: null, ticketKey: null, target: null, summary: "old2", payload: null, outcome: "skipped", error: null });
    setNow(20_000);
    actions.record("pr_open", { summary: "newer", outcome: "done" });
    expect(repo.list()).toHaveLength(3);
  });
});

describe("ExternalAuditRepo", () => {
  it("filters by kind, caps the limit and drops kinds it does not know", () => {
    const db = memDb();
    const repo = new ExternalAuditRepo(db);
    repo.insert({ ts: 1, kind: "pr_open", repoSlug: null, ticketKey: null, target: null, summary: "a", payload: null, outcome: "done", error: null });
    repo.insert({ ts: 2, kind: "ci_rerun", repoSlug: null, ticketKey: null, target: null, summary: "b", payload: null, outcome: "done", error: null });
    db.prepare(`INSERT INTO external_action_audit (ts, kind, summary, outcome) VALUES (3, 'from_the_future', 'c', 'done')`).run();
    expect(repo.list().map((e) => e.summary)).toEqual(["b", "a"]);
    expect(repo.list({ kind: "pr_open" }).map((e) => e.summary)).toEqual(["a"]);
    expect(repo.list({ limit: 1 })).toHaveLength(1);
    expect(repo.prune(2)).toBe(1);
  });
});

describe("update checks in the audit (BTL-253)", () => {
  it("records and lists update_check rows next to outward actions, without a switch of its own", () => {
    const { repo, actions } = setup();
    expect(EXTERNAL_ACTIONS).not.toContain("update_check");
    actions.record("update_check", { target: "repos/yul761/shipherd/releases/latest", summary: "latest 4.1.0", outcome: "done" });
    actions.record("update_check", { target: "repos/yul761/shipherd/releases/latest", summary: "failed", outcome: "failed", error: "offline" });
    expect(repo.list().map((e) => [e.kind, e.outcome])).toEqual([["update_check", "failed"], ["update_check", "done"]]);
    expect(repo.list({ kind: "update_check" })).toHaveLength(2);
  });
});
