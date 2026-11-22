import { describe, expect, it, vi } from "vitest";
import type { ReleaseInfo } from "../../shared/update";
import type { LatestReleaseResult } from "./release-source";
import { UPDATE_CHECK_INTERVAL_MS, UpdateChecker, type UpdateAuditEntry, type UpdateSettingKey } from "./update-checker";

const DAY = 24 * 3600_000;
const rel = (version: string): ReleaseInfo => ({ version, tag: `v${version}`, url: `https://github.com/yul761/butler/releases/tag/v${version}`, publishedAt: 1, notes: `notes ${version}` });
const ok = (version: string, extra: Partial<{ draft: boolean; prerelease: boolean }> = {}): LatestReleaseResult => ({ ok: true, release: rel(version), draft: false, prerelease: false, ...extra });

function setup(o: { results?: LatestReleaseResult[]; gh?: boolean; settings?: Partial<Record<UpdateSettingKey, string>>; current?: string } = {}) {
  const store: Record<string, string> = { updateCheckEnabled: "1", updateLastCheckAt: "", updateLatest: "", updateSkippedVersion: "", ...o.settings };
  const results = [...(o.results ?? [ok("4.1.0")])];
  const audit: UpdateAuditEntry[] = [];
  let now = 10 * DAY;
  let fetches = 0;
  let notified = 0;
  let gh = o.gh ?? true;
  const checker = new UpdateChecker({
    current: o.current ?? "4.0.0",
    settings: { get: (k) => store[k] ?? "", set: (k, v) => { store[k] = v; } },
    ghAvailable: () => gh,
    fetchLatest: async () => (fetches++, results.length > 1 ? results.shift()! : results[0]!),
    audit: (e) => audit.push(e),
    now: () => now,
    notify: () => { notified++; },
    log: () => undefined,
  });
  return {
    checker, store, audit,
    fetches: () => fetches, notified: () => notified,
    advance: (ms: number) => { now += ms; },
    setGh: (v: boolean) => { gh = v; },
    now: () => now,
  };
}

describe("UpdateChecker.autoCheck", () => {
  it("checks once, shows the newer version and records it in the audit", async () => {
    const t = setup();
    await t.checker.autoCheck();
    expect(t.fetches()).toBe(1);
    expect(t.store.updateLastCheckAt).toBe(String(t.now()));
    expect(t.checker.view().banner?.version).toBe("4.1.0");
    expect(t.audit).toEqual([expect.objectContaining({ outcome: "done", target: "repos/yul761/butler/releases/latest" })]);
    expect(t.audit[0]!.summary).toContain("4.1.0");
    expect(t.notified()).toBeGreaterThan(0);
  });

  it("asks GitHub at most once a day, even when a check fails", async () => {
    const t = setup({ results: [{ ok: false, reason: "offline", detail: "dial tcp" }, ok("4.1.0")] });
    await t.checker.autoCheck();
    expect(t.audit).toEqual([expect.objectContaining({ outcome: "failed", error: expect.stringContaining("dial tcp") })]);
    t.advance(DAY - 1);
    await t.checker.autoCheck();
    expect(t.fetches()).toBe(1);
    t.advance(1);
    await t.checker.autoCheck();
    expect(t.fetches()).toBe(2);
    expect(t.checker.view().banner?.version).toBe("4.1.0");
  });

  it("stays quiet when a check fails: no banner, the cached release is kept", async () => {
    const t = setup({ results: [ok("4.1.0"), { ok: false, reason: "rate_limited", detail: "" }] });
    await t.checker.autoCheck();
    t.advance(DAY);
    await t.checker.autoCheck();
    expect(t.checker.view().banner?.version).toBe("4.1.0");
    expect(t.checker.view().lastManual).toBeNull();
  });

  it("does not run gh at all without gh, and does not count that as a check", async () => {
    const t = setup({ gh: false });
    await t.checker.autoCheck();
    expect(t.fetches()).toBe(0);
    expect(t.audit).toEqual([]);
    expect(t.store.updateLastCheckAt).toBe("");
    t.setGh(true);
    await t.checker.autoCheck();
    expect(t.fetches()).toBe(1);
  });

  it("does nothing while the switch is off", async () => {
    const t = setup({ settings: { updateCheckEnabled: "0" } });
    await t.checker.autoCheck();
    expect(t.fetches()).toBe(0);
  });

  it("uses the cached release after a restart within a day", async () => {
    const t = setup({ settings: { updateLastCheckAt: String(10 * DAY - 3600_000), updateLatest: JSON.stringify(rel("4.2.0")) } });
    await t.checker.autoCheck();
    expect(t.fetches()).toBe(0);
    expect(t.checker.view().banner?.version).toBe("4.2.0");
  });

  it("clears the cached release when GitHub's latest is not newer", async () => {
    const t = setup({ results: [ok("4.0.0")], settings: { updateLatest: JSON.stringify(rel("4.2.0")) } });
    await t.checker.autoCheck();
    expect(t.store.updateLatest).toBe("");
    expect(t.checker.view().banner).toBeNull();
  });

  it("never offers drafts or pre-releases", async () => {
    for (const r of [ok("4.1.0", { draft: true }), ok("4.1.0", { prerelease: true }), ok("4.1.0-rc.1")]) {
      const t = setup({ results: [r] });
      await t.checker.autoCheck();
      expect(t.checker.view().banner).toBeNull();
    }
  });

  it("runs one check at a time", async () => {
    const t = setup();
    await Promise.all([t.checker.autoCheck(), t.checker.autoCheck(), t.checker.checkNow()]);
    expect(t.fetches()).toBe(1);
  });
});

describe("UpdateChecker.checkNow", () => {
  it("ignores the daily limit and the switch, and reports the result", async () => {
    const t = setup({ results: [ok("4.0.0"), ok("4.1.0")], settings: { updateCheckEnabled: "0" } });
    expect(await t.checker.checkNow()).toEqual({ kind: "latest", current: "4.0.0", latest: "4.0.0", at: t.now() });
    const r = await t.checker.checkNow();
    expect(r.kind).toBe("available");
    expect(t.fetches()).toBe(2);
    expect(t.checker.view().lastManual).toEqual(r);
    // 开关关着，但这是这次手动查到的：提示条照样出来。
    expect(t.checker.view().banner?.version).toBe("4.1.0");
  });

  it("says why it could not check", async () => {
    const t = setup({ results: [{ ok: false, reason: "not_logged_in", detail: "gh auth login" }] });
    expect(await t.checker.checkNow()).toMatchObject({ kind: "failed", reason: "not_logged_in", detail: "gh auth login" });
    const noGh = setup({ gh: false });
    expect(await noGh.checker.checkNow()).toMatchObject({ kind: "failed", reason: "no_gh" });
    expect(noGh.audit).toEqual([]);
  });
});

describe("UpdateChecker banner", () => {
  it("hides a skipped version until a newer one comes out", async () => {
    const t = setup({ results: [ok("4.1.0"), ok("4.1.0"), ok("4.2.0")] });
    await t.checker.autoCheck();
    t.checker.skip("4.1.0");
    expect(t.store.updateSkippedVersion).toBe("4.1.0");
    expect(t.checker.view().banner).toBeNull();
    t.advance(DAY);
    await t.checker.autoCheck();
    expect(t.checker.view().banner).toBeNull();
    t.advance(DAY);
    await t.checker.autoCheck();
    expect(t.checker.view().banner?.version).toBe("4.2.0");
  });

  it("closing hides it for this run only", async () => {
    const t = setup();
    await t.checker.autoCheck();
    t.checker.dismiss("4.1.0");
    expect(t.checker.view().banner).toBeNull();
    const restarted = new UpdateChecker({
      current: "4.0.0", settings: { get: (k) => t.store[k] ?? "", set: () => undefined }, ghAvailable: () => true,
      fetchLatest: async () => ok("4.1.0"), audit: () => undefined, now: () => t.now(), notify: () => undefined, log: () => undefined,
    });
    expect(restarted.view().banner?.version).toBe("4.1.0");
  });

  it("hides the banner when the switch is turned off, and after upgrading", () => {
    const t = setup({ settings: { updateLatest: JSON.stringify(rel("4.1.0")), updateLastCheckAt: "1" } });
    expect(t.checker.view().banner?.version).toBe("4.1.0");
    t.store.updateCheckEnabled = "0";
    expect(t.checker.view().banner).toBeNull();
    const upgraded = setup({ current: "4.1.0", settings: { updateLatest: JSON.stringify(rel("4.1.0")) } });
    expect(upgraded.checker.view().banner).toBeNull();
  });

  it("ignores a broken cache", () => {
    const t = setup({ settings: { updateLatest: "{not json", updateLastCheckAt: "abc" } });
    expect(t.checker.view()).toMatchObject({ banner: null, lastCheckedAt: null, current: "4.0.0", enabled: true, checking: false });
  });
});

describe("UpdateChecker.start", () => {
  it("checks at start, then on an hourly timer once a day has passed, and stops", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.checker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.fetches()).toBe(1);
      t.advance(UPDATE_CHECK_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
      expect(t.fetches()).toBe(1);
      t.advance(DAY);
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
      expect(t.fetches()).toBe(2);
      t.checker.stop();
      t.advance(2 * DAY);
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
      expect(t.fetches()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
