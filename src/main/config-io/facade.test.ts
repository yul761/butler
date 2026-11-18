import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { JobsRepo } from "../db/jobs-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { ConfigBackups } from "./backup-job";
import { configIoFacade } from "./facade";
import { ConfigIoService, defaultRegistry } from ".";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(saveTo: string | null, openFrom: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "butler-facade-"));
  dirs.push(dir);
  const db = memDb();
  const repo = new LessonsRepo(db);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db)]);
  let v = 1;
  const now = () => 1_700_000_000_000;
  const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => v, set: (x) => (v = x) }, now });
  const registry = defaultRegistry();
  const backupDir = join(dir, "backups");
  const io = new ConfigIoService({ db, repo, policies, recorder, registry, butlerVersion: "3.0.0", backupDir, now });
  const backups = new ConfigBackups({ io, registry, jobs: new JobsRepo(db), repo, backupDir, now, intervalDays: () => 0, keep: () => 3, reminderDays: () => 0, lastExportAt: () => null });
  const opened: string[] = [];
  const names: string[] = [];
  let notified = 0;
  const facade = configIoFacade({
    io, backups, backupDir, now, notify: () => notified++,
    openPath: async (p) => opened.push(p),
    dialogs: {
      save: async (name) => {
        names.push(name);
        return saveTo && join(dir, saveTo);
      },
      open: async () => openFrom && join(dir, openFrom),
    },
  });
  return { facade, repo, dir, opened, names, backupDir, notified: () => notified };
}

describe("configIoFacade", () => {
  const req = { scope: { kind: "all" as const }, options: { content: "all" as const, includeSourceUrls: false } };

  it("treats a closed dialog as cancelled", async () => {
    const { facade } = setup(null, null);
    expect(await facade.exportTo(req)).toEqual({ ok: false, reason: "cancelled" });
    expect(await facade.importPreview()).toEqual({ ok: false, reason: "cancelled" });
  });

  it("exports to the picked file, suggests a file name and previews it back", async () => {
    const { facade, dir, names, notified } = setup("out.json", "out.json");
    const r = await facade.exportTo(req);
    expect(r.ok).toBe(true);
    expect(names[0]).toMatch(/^butler-export-.+\.json$/);
    expect(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).format).toBe("butler-config");
    expect(notified()).toBe(1);
    await facade.exportTo({ ...req, starter: { name: "Web / rules!" } });
    expect(names[1]).toMatch(/^butler-starter-Web-rules-.+\.json$/);
    const p = await facade.importPreview();
    expect(p.ok).toBe(true);
  });

  it("backs up now and opens the backups folder (creating it first)", async () => {
    const { facade, opened, backupDir } = setup(null, null);
    const r = facade.backupNow();
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.name).toMatch(/^manual-/);
    expect(facade.status().backups).toHaveLength(1);
    rmSync(backupDir, { recursive: true, force: true });
    await facade.openBackups();
    expect(existsSync(backupDir)).toBe(true);
    expect(opened).toEqual([backupDir]);
  });
});
