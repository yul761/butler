import { JOB_CONFIG_BACKUP, type JobsRepo } from "../db/jobs-repo";
import type { LessonsRepo } from "../db/lessons-repo";
import type { ConfigIoStatus } from "../../shared/config-io";
import type { ConfigIoService } from "./service";
import type { SectionRegistry } from "./registry";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 备份失败之后隔多久再试。 */
const RETRY_BACKOFF_MS = 60 * 60 * 1000;

export interface ConfigBackupDeps {
  io: ConfigIoService;
  registry: SectionRegistry;
  jobs: Pick<JobsRepo, "get" | "record">;
  repo: Pick<LessonsRepo, "lessons">;
  backupDir: string;
  intervalDays: () => number;
  keep: () => number;
  reminderDays: () => number;
  lastExportAt: () => number | null;
  now: () => number;
  log?: (msg: string, e?: unknown) => void;
}

/** 定期自动备份（job config_backup）和「该导出了」的提醒。 */
export class ConfigBackups {
  constructor(private readonly d: ConfigBackupDeps) {}

  /** 调度 tick 时调用：到期了就备份一次，再删掉多出来的自动备份。返回写出的文件（没到期为 null）。 */
  tick(): string | null {
    const days = this.d.intervalDays();
    if (days <= 0) return null;
    const now = this.d.now();
    const { lastRunAt, lastStatus } = this.d.jobs.get(JOB_CONFIG_BACKUP);
    if (lastRunAt !== null && lastStatus === "ok" && now - lastRunAt < days * DAY_MS) return null;
    if (lastRunAt !== null && lastStatus === "failed" && now - lastRunAt < RETRY_BACKOFF_MS) return null;
    try {
      const file = this.d.io.backup("auto");
      this.d.io.pruneAutoBackups(this.d.keep());
      this.d.jobs.record(JOB_CONFIG_BACKUP, now, "ok", null);
      return file;
    } catch (e) {
      this.d.log?.("config backup failed", e);
      this.d.jobs.record(JOB_CONFIG_BACKUP, now, "failed", e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /** 设置页的「现在备份」：手动备份不参与轮换。 */
  backupNow(): string {
    return this.d.io.backup("manual");
  }

  status(): ConfigIoStatus {
    const now = this.d.now();
    const backups = this.d.io.backups();
    const lastBackupAt = backups.length ? Math.max(...backups.map((b) => b.at)) : null;
    const lastExportAt = this.d.lastExportAt();
    const reminderDays = this.d.reminderDays();
    let remind = false;
    if (reminderDays > 0) {
      const confirmed = this.d.repo.lessons({ status: ["confirmed"] });
      if (confirmed.length > 0) {
        // 从最近一次导出 / 备份算；都没有就从最早一条已确认规矩算（刚开始用的人不会第一天就被提醒）。
        const since = Math.max(lastExportAt ?? 0, lastBackupAt ?? 0) || Math.min(...confirmed.map((l) => l.createdAt));
        remind = now - since >= reminderDays * DAY_MS;
      }
    }
    return {
      lastExportAt, lastBackupAt, backupDir: this.d.backupDir, backups, intervalDays: this.d.intervalDays(), keep: this.d.keep(), reminderDays, remind,
      sections: this.d.registry.list().map((s) => ({ id: s.id, content: s.content })),
    };
  }
}
