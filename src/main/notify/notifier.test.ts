import { afterEach, describe, expect, it } from "vitest";
import { ExternalAuditRepo } from "../db/external-audit-repo";
import { NotificationLogRepo } from "../db/interrupts-repo";
import { SecretsRepo } from "../db/secrets-repo";
import { ExternalActions } from "../external/actions";
import { fakeSecretBox } from "../gateway/testing";
import type { WebhookRequest, WebhookResult } from "../gateway/webhook";
import { setLang } from "../i18n";
import { memDb } from "../test-utils";
import { inQuietHours, Notifier, notifyFromMetric, type NotifySetting } from "./notifier";
import { WebhookStore } from "./webhook-store";

afterEach(() => setLang("zh"));

function setup(o: { on?: boolean; settings?: Partial<Record<NotifySetting, string>>; minute?: number; result?: WebhookResult; url?: string | null } = {}) {
  const db = memDb();
  const audit = new ExternalAuditRepo(db);
  const actions = new ExternalActions({ repo: audit, setting: () => (o.on === false ? "0" : "1"), now: () => 1 });
  const log = new NotificationLogRepo(db);
  const webhook = new WebhookStore({ secrets: new SecretsRepo(db), box: fakeSecretBox(), now: () => 1 });
  if (o.url !== null) webhook.save(o.url ?? "https://ntfy.example/topic");
  const posted: Omit<WebhookRequest, "fetch">[] = [];
  const timers: (() => void)[] = [];
  const settings: Record<NotifySetting, string> = { notifyFormat: "json", notifyEvents: "decision_needed,pr_high_risk,pr_ready,cost_breaker,review_comment", notifyDetails: "0", notifyQuietHours: "", ...o.settings };
  const clock = { minute: o.minute ?? 12 * 60 };
  const n = new Notifier({
    actions, log, webhook, post: async (r) => (posted.push(r), o.result ?? { ok: true, status: 200 }), setting: (k) => settings[k], now: () => 100,
    minuteOfDay: () => clock.minute, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {},
  });
  return { n, log, audit, posted, timers, webhook, clock, settings };
}

describe("inQuietHours", () => {
  it("handles same-day and overnight windows, and empty or bad values as no window", () => {
    expect(inQuietHours("22:00-08:00", 23 * 60)).toBe(true);
    expect(inQuietHours("22:00-08:00", 7 * 60 + 59)).toBe(true);
    expect(inQuietHours("22:00-08:00", 8 * 60)).toBe(false);
    expect(inQuietHours("12:00-13:30", 13 * 60)).toBe(true);
    expect(inQuietHours("12:00-13:30", 11 * 60)).toBe(false);
    expect(inQuietHours("", 0)).toBe(false);
    expect(inQuietHours("nonsense", 0)).toBe(false);
  });
});

describe("Notifier (ws-j)", () => {
  it("does nothing at all while push notifications are off", async () => {
    const { n, log, posted, timers, audit } = setup({ on: false });
    n.emit("decision_needed");
    expect(timers).toEqual([]);
    await n.flush("decision_needed");
    expect(posted).toEqual([]);
    expect(log.recent()).toEqual([]);
    expect(audit.list()).toEqual([]);
  });

  it("gathers events of one kind for a minute and sends only the kind and count by default", async () => {
    const { n, log, posted, timers } = setup();
    n.emit("decision_needed", { ticketKey: "T-1" });
    n.emit("decision_needed", { ticketKey: "T-2" });
    n.emit("pr_ready", { prNumber: 7 });
    expect(timers).toHaveLength(2);
    expect(posted).toEqual([]);
    await n.flush("decision_needed");
    expect(posted).toHaveLength(1);
    const body = JSON.parse(posted[0]!.body);
    expect(body).toMatchObject({ title: "Butler", event: "decision_needed", count: 2 });
    expect(body.text).toContain("2");
    expect(posted[0]!.body).not.toContain("T-1");
    expect(posted[0]!.contentType).toBe("application/json");
    expect(log.recent()[0]).toMatchObject({ event: "decision_needed", count: 2, status: "sent", host: "ntfy.example" });
  });

  it("adds ticket keys and PR numbers only when details are on, and uses ntfy format when asked", async () => {
    const { n, posted } = setup({ settings: { notifyDetails: "1", notifyFormat: "ntfy" } });
    n.emit("pr_high_risk", { ticketKey: "T-1", prNumber: 12 });
    await n.flush("pr_high_risk");
    expect(posted[0]!.body).toContain("T-1 #12");
    expect(posted[0]!.headers).toEqual({ Title: "Butler" });
    expect(posted[0]!.contentType).toMatch(/^text\/plain/);
  });

  it("drops events that are not chosen or fall into quiet hours, and logs why", () => {
    const filtered = setup({ settings: { notifyEvents: "pr_ready" } });
    filtered.n.emit("decision_needed");
    expect(filtered.log.recent()[0]).toMatchObject({ status: "filtered", event: "decision_needed" });
    const quiet = setup({ settings: { notifyQuietHours: "22:00-08:00" }, minute: 23 * 60 });
    quiet.n.emit("cost_breaker");
    expect(quiet.timers).toEqual([]);
    expect(quiet.log.recent()[0]).toMatchObject({ status: "quiet", event: "cost_breaker" });
  });

  it("checks quiet hours and the chosen events again when the minute is up", async () => {
    const late = setup({ settings: { notifyQuietHours: "22:00-08:00" }, minute: 22 * 60 - 1 });
    late.n.emit("decision_needed");
    late.n.emit("decision_needed");
    late.clock.minute = 22 * 60;
    await late.n.flush("decision_needed");
    expect(late.posted).toEqual([]);
    expect(late.log.recent()[0]).toMatchObject({ status: "quiet", event: "decision_needed", count: 2 });
    const unticked = setup();
    unticked.n.emit("pr_ready");
    unticked.settings.notifyEvents = "decision_needed";
    await unticked.n.flush("pr_ready");
    expect(unticked.posted).toEqual([]);
    expect(unticked.log.recent()[0]).toMatchObject({ status: "filtered", event: "pr_ready" });
  });

  it("logs a failure without the response body, and a missing address", async () => {
    const failing = setup({ result: { ok: false, status: 500, error: "webhook 返回 HTTP 500" } });
    failing.n.emit("review_comment");
    await failing.n.flush("review_comment");
    expect(failing.log.recent()[0]).toMatchObject({ status: "failed", error: "webhook 返回 HTTP 500" });
    const none = setup({ url: null });
    none.n.emit("review_comment");
    await none.n.flush("review_comment");
    expect(none.log.recent()[0]).toMatchObject({ status: "failed", host: null });
  });

  it("sends a test message, which is refused while the switch is off", async () => {
    setLang("en");
    const on = setup();
    expect(await on.n.test()).toEqual({ ok: true, error: null });
    expect(JSON.parse(on.posted[0]!.body).text).toContain("test");
    const off = setup({ on: false });
    expect((await off.n.test()).ok).toBe(false);
    expect(off.posted).toEqual([]);
  });
});

describe("WebhookStore", () => {
  it("keeps the address encrypted and shows only the host", () => {
    const { webhook } = setup({ url: "https://hooks.example/services/SECRET" });
    expect(webhook.state()).toEqual({ saved: true, host: "hooks.example", unreadable: false, encryptionAvailable: true });
    expect(JSON.stringify(webhook.state())).not.toContain("SECRET");
    expect(() => webhook.save("http://hooks.example/x")).toThrow();
    expect(webhook.clear().saved).toBe(false);
    expect(webhook.get()).toBeNull();
  });
});

describe("notifyFromMetric", () => {
  it("maps only the breaker and PR events, and keeps just the ticket key and PR number", () => {
    expect(notifyFromMetric("cost.pause", { ticketKey: "T-1", data: { subject: "x", detail: "secret text" } })).toEqual({ event: "cost_breaker", ref: { ticketKey: "T-1", prNumber: null } });
    expect(notifyFromMetric("cost.stop")?.event).toBe("cost_breaker");
    expect(notifyFromMetric("pr_risk_high", { data: { prNumber: 12 } })).toEqual({ event: "pr_high_risk", ref: { ticketKey: null, prNumber: 12 } });
    expect(notifyFromMetric("pr_ready", { data: { number: "7" } })?.ref.prNumber).toBeNull();
    expect(notifyFromMetric("intake.decision", { ticketKey: "T-3", data: { state: "needs_decision" } })).toEqual({ event: "intake_decision", ref: { ticketKey: "T-3", prNumber: null } });
    expect(notifyFromMetric("interrupt")).toBeNull();
    expect(notifyFromMetric("pr_merged")).toBeNull();
  });
});
