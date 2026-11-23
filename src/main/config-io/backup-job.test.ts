import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { JobsRepo, JOB_CONFIG_BACKUP } from "../db/jobs-repo";
import { SettingsRepo } from "../db/settings-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { configBackupIntervalDays, configBackupKeep, configExportReminderDays, normalizeSetting } from "../settings/settings-values";
import { ConfigBackups } from "./backup-job";
import { ConfigIoService, defaultRegistry } from ".";

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "shipherd-bk-"));
  dirs.push(dir);
  const db = memDb();
  const repo = new LessonsRepo(db);
  const jobs = new JobsRepo(db);
  const settings = new SettingsRepo(db);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db)]);
  let t = 10 * DAY;
  const now = () => t;
  let v = 1;
  const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => v, set: (x) => (v = x) }, now });
  const registry = defaultRegistry();
  const backupDir = join(dir, "backups");
  const io = new ConfigIoService({ db, repo, policies, recorder, registry, shipherdVersion: "3.0.0", backupDir, now, onExported: (at) => settings.set("configLastExportAt", String(at)) });
  const backups = new ConfigBackups({
    io, registry, jobs, repo, backupDir, now,
    intervalDays: () => configBackupIntervalDays(settings), keep: () => configBackupKeep(settings), reminderDays: () => configExportReminderDays(settings),
    lastExportAt: () => (settings.get("configLastExportAt") ? Number(settings.get("configLastExportAt")) : null),
  });
  return { repo, jobs, settings, io, backups, dir, advance: (ms: number) => (t += ms) };
}

describe("config backup settings", () => {
  it("validate and fall back to defaults", () => {
    expect(normalizeSetting("configBackupIntervalDays", " 7 ")).toBe("7");
    expect(normalizeSetting("configBackupIntervalDays", "0")).toBe("0");
    expect(() => normalizeSetting("configBackupIntervalDays", "400")).toThrow();
    expect(() => normalizeSetting("configBackupKeep", "0")).toThrow();
    expect(() => normalizeSetting("configExportReminderDays", "-1")).toThrow();
    const { settings } = setup();
    expect([configBackupIntervalDays(settings), configBackupKeep(settings), configExportReminderDays(settings)]).toEqual([0, 10, 30]);
    settings.set("configBackupKeep", "junk");
    expect(configBackupKeep(settings)).toBe(10);
  });
});

describe("ConfigBackups", () => {
  it("does nothing while off, then backs up once per interval and keeps the newest N", () => {
    const { settings, backups, jobs, io, advance } = setup();
    expect(backups.tick()).toBeNull();
    settings.set("configBackupIntervalDays", "2");
    settings.set("configBackupKeep", "2");
    expect(backups.tick()).toMatch(/auto-/);
    expect(jobs.get(JOB_CONFIG_BACKUP).lastStatus).toBe("ok");
    advance(DAY);
    expect(backups.tick()).toBeNull();
    for (let i = 0; i < 3; i++) {
      advance(2 * DAY);
      expect(backups.tick()).not.toBeNull();
    }
    expect(io.backups().filter((b) => b.name.startsWith("auto-"))).toHaveLength(2);
    backups.backupNow();
    expect(io.backups()).toHaveLength(3);
  });

  it("records a failure and backs off", () => {
    const { settings, jobs, dir, repo, advance } = setup();
    settings.set("configBackupIntervalDays", "1");
    const blocked = new ConfigBackups({
      io: { backup: () => { throw new Error("disk full"); }, pruneAutoBackups: () => 0, backups: () => [] } as unknown as ConfigIoService,
      registry: defaultRegistry(), jobs, repo, backupDir: dir, now: () => 0, intervalDays: () => 1, keep: () => 1, reminderDays: () => 0, lastExportAt: () => null,
    });
    expect(blocked.tick()).toBeNull();
    expect(jobs.get(JOB_CONFIG_BACKUP)).toMatchObject({ lastStatus: "failed", lastError: "disk full" });
    advance(0);
  });

  it("reminds to export when confirmed lessons have gone unexported for the reminder period", () => {
    const { repo, backups, io, advance, dir } = setup();
    expect(backups.status().remind).toBe(false);
    repo.upsertRepo("acme/web", "", 1);
    const id = repo.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "x", why: "", at: 10 * DAY, source: { prNumber: 1, url: null, slug: "acme/web", runId: null } });
    repo.setStatus(id, "confirmed", 10 * DAY);
    expect(backups.status().remind).toBe(false);
    advance(31 * DAY);
    const s = backups.status();
    expect(s).toMatchObject({ remind: true, lastExportAt: null, intervalDays: 0, keep: 10, reminderDays: 30 });
    expect(s.sections.map((x) => x.id)).toEqual(["products", "policies", "prPolicies", "lessons", "checks", "baseline_rules", "models", "permissions", "stacks", "baselines"]);
    io.writeExport({ scope: { kind: "all" }, options: { content: "all", includeSourceUrls: false } }, join(dir, "e.json"));
    expect(backups.status()).toMatchObject({ remind: false, lastExportAt: 41 * DAY });
  });
});
