// 更新提示（BTL-253）：每天最多一次经用户的 gh 查 GitHub 上有没有新版本，有就在界面顶部提示。只提示，不下载、不安装。
// 自动检查失败一律静默（只写日志）；手动检查把结果和原因交给界面。每次真的跑了 gh 的查询都记进审计。
import { compareVersions, displayVersion, isNewerRelease, parseVersion, type ReleaseInfo, type UpdateFailReason, type UpdateCheckResult, type UpdateView } from "../../shared/update";
import { RELEASE_API_PATH, type LatestReleaseResult } from "./release-source";

export const UPDATE_CHECK_DAY_MS = 24 * 3600_000;
/** 多久看一次「满 24 小时没有」：Butler 一开好几天也能每天查一次。 */
export const UPDATE_CHECK_INTERVAL_MS = 3600_000;

export type UpdateSettingKey = "updateCheckEnabled" | "updateLastCheckAt" | "updateLatest" | "updateSkippedVersion";

export interface UpdateAuditEntry {
  outcome: "done" | "failed";
  target: string;
  summary: string;
  error: string | null;
}

export interface UpdateCheckerDeps {
  /** 正在跑的版本（app.getVersion()）。 */
  current: string;
  settings: { get(key: UpdateSettingKey): string; set(key: UpdateSettingKey, value: string): void };
  ghAvailable(): boolean;
  fetchLatest(): Promise<LatestReleaseResult>;
  audit(e: UpdateAuditEntry): void;
  now(): number;
  notify(): void;
  log(msg: string, err?: unknown): void;
  /** 等 gh 按登录 shell 的 PATH 探测完（手动检查也等，免得启动后马上点被说成没装 gh）。 */
  ready?(): Promise<void>;
  /** 审计里的摘要和原因（主进程文案）；每次记审计时现取，跟着当前语言。 */
  text?(): UpdateAuditText;
}

export interface UpdateAuditText {
  found(latest: string, newer: boolean): string;
  failed: string;
  reasons: Record<UpdateFailReason, string>;
}

const DEFAULT_TEXT: UpdateAuditText = {
  found: (latest, newer) => `latest ${latest}${newer ? " (newer)" : ""}`,
  failed: "update check failed",
  reasons: { no_gh: "no gh", not_logged_in: "gh not logged in", offline: "offline", rate_limited: "rate limited", no_release: "no release", bad_response: "bad response", failed: "gh failed" },
};

function readRelease(raw: string): ReleaseInfo | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<ReleaseInfo> | null;
    if (!j || typeof j.version !== "string" || typeof j.tag !== "string" || typeof j.url !== "string") return null;
    return { version: j.version, tag: j.tag, url: j.url, publishedAt: typeof j.publishedAt === "number" ? j.publishedAt : null, notes: typeof j.notes === "string" ? j.notes : "" };
  } catch {
    return null;
  }
}

export class UpdateChecker {
  private running: Promise<UpdateCheckResult> | null = null;
  private lastManual: UpdateCheckResult | null = null;
  /** 这次运行里手动查到的新版本：开关关着也显示提示条。 */
  private manualFound: string | null = null;
  private readonly dismissed = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 退出时置位：还在跑的 gh 回来以后不再写设置和审计（数据库已经关了）。 */
  private stopped = false;

  constructor(private readonly d: UpdateCheckerDeps) {}

  private get enabled(): boolean {
    return this.d.settings.get("updateCheckEnabled") !== "0";
  }

  private lastCheckedAt(): number | null {
    const n = Number(this.d.settings.get("updateLastCheckAt"));
    return this.d.settings.get("updateLastCheckAt") !== "" && Number.isFinite(n) && n > 0 ? n : null;
  }

  /** 启动后查一次（够 24 小时的话），之后每小时看一次。 */
  start(intervalMs = UPDATE_CHECK_INTERVAL_MS): void {
    if (this.timer) clearInterval(this.timer);
    this.stopped = false;
    void this.autoCheck();
    this.timer = setInterval(() => void this.autoCheck(), intervalMs);
    this.timer.unref?.();
  }

  /** 停掉定时器（退出时）：之后查完的结果不再写。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  /** 自动检查：开关开着、离上次满 24 小时才查。从不抛错，失败只写日志。 */
  async autoCheck(): Promise<void> {
    if (this.running) {
      await this.running;
      return;
    }
    if (!this.enabled) return;
    const last = this.lastCheckedAt();
    // 上次检查的时间在将来（当时时钟不对）：当作过期，不然要等到那个时间再过一天才查。
    const since = last === null ? null : this.d.now() - last;
    if (since !== null && since >= 0 && since < UPDATE_CHECK_DAY_MS) return;
    const r = await this.run();
    if (r.kind === "failed" && r.reason !== "no_gh") this.d.log(`update check failed: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
  }

  /** 手动检查（菜单「检查更新…」、关于页的按钮）：不看节流和开关。 */
  async checkNow(): Promise<UpdateCheckResult> {
    const r = await (this.running ?? this.run());
    this.lastManual = r;
    // 手动查到的版本：跳过过、关过、开关关着都照样显示提示条（结果里说了去提示条下载）。
    if (r.kind === "available") {
      this.manualFound = r.release.version;
      this.dismissed.delete(r.release.version);
    }
    this.d.notify();
    return r;
  }

  private run(): Promise<UpdateCheckResult> {
    const p = this.check().catch((e: unknown): UpdateCheckResult => {
      this.d.log("update check failed", e);
      return { kind: "failed", reason: "failed", detail: e instanceof Error ? e.message : String(e), at: this.d.now() };
    }).finally(() => {
      this.running = null;
      this.d.notify();
    });
    this.running = p;
    this.d.notify();
    return p;
  }

  private async check(): Promise<UpdateCheckResult> {
    await this.d.ready?.();
    // 没有 gh：不启动进程、不算查过、不记审计。
    if (!this.d.ghAvailable()) return { kind: "failed", reason: "no_gh", detail: "", at: this.d.now() };
    let res: LatestReleaseResult;
    try {
      res = await this.d.fetchLatest();
    } catch (e) {
      res = { ok: false, reason: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
    const at = this.d.now();
    if (this.stopped) return { kind: "failed", reason: "failed", detail: "stopped", at };
    const text = this.d.text?.() ?? DEFAULT_TEXT;
    // 版本号看不懂（tag 不是 SemVer，或者当前版本不是）：比不了，不能说「已是最新」。
    if (res.ok && (!parseVersion(res.release.tag) || !parseVersion(this.d.current))) res = { ok: false, reason: "bad_response", detail: `version ${res.release.tag}` };
    if (res.ok || res.reason !== "no_gh") this.d.settings.set("updateLastCheckAt", String(at));
    if (!res.ok) {
      if (res.reason !== "no_gh") this.d.audit({ outcome: "failed", target: RELEASE_API_PATH, summary: text.failed, error: [text.reasons[res.reason], res.detail].filter(Boolean).join(": ") });
      return { kind: "failed", reason: res.reason, detail: res.detail, at };
    }
    const newer = isNewerRelease({ tag: res.release.tag, draft: res.draft, prerelease: res.prerelease }, this.d.current);
    this.d.settings.set("updateLatest", newer ? JSON.stringify(res.release) : "");
    this.d.audit({ outcome: "done", target: RELEASE_API_PATH, summary: text.found(res.release.version, newer), error: null });
    return newer ? { kind: "available", release: res.release, at } : { kind: "latest", current: this.d.current, latest: res.release.version, at };
  }

  /** 「跳过这个版本」：之后只有更高的版本才再提示。 */
  skip(version: string): void {
    this.d.settings.set("updateSkippedVersion", displayVersion(version));
    if (this.manualFound === displayVersion(version)) this.manualFound = null;
    this.d.notify();
  }

  /** 关闭：这次运行里不再提示这一版。 */
  dismiss(version: string): void {
    this.dismissed.add(displayVersion(version));
    this.d.notify();
  }

  /** 提示条要显示的 release；没有为 null。 */
  private banner(): ReleaseInfo | null {
    const latest = readRelease(this.d.settings.get("updateLatest"));
    if (!latest) return null;
    // 缓存的 release 已经不比当前新（升级过了）。
    const vsCurrent = compareVersions(latest.version, this.d.current);
    if (vsCurrent === null || vsCurrent <= 0) return null;
    const forced = this.manualFound === latest.version;
    const skipped = forced ? "" : this.d.settings.get("updateSkippedVersion");
    if (skipped) {
      const vsSkipped = compareVersions(latest.version, skipped);
      if (vsSkipped !== null && vsSkipped <= 0) return null;
    }
    if (this.dismissed.has(latest.version)) return null;
    if (!this.enabled && !forced) return null;
    return latest;
  }

  /** 关于页和下载按钮要的 release 页（缓存里那一条）。 */
  latestUrl(): string | null {
    return readRelease(this.d.settings.get("updateLatest"))?.url ?? null;
  }

  view(): UpdateView {
    return { current: this.d.current, enabled: this.enabled, lastCheckedAt: this.lastCheckedAt(), banner: this.banner(), checking: this.running !== null, lastManual: this.lastManual };
  }
}
