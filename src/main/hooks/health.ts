import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { GhAuthState, HandoffCommandStatus, HealthReport, HookStatus } from "../../shared/types";
import { handoffCommandPath, handoffCommandStatus, installHandoffCommand, uninstallHandoffCommand } from "../handoff/command";
import { probeClaude } from "../claude/capabilities";
import { locateClaude, readLoginShellPath, wellKnownClaudePaths } from "../claude/locate";
import { claudeLoginState } from "../claude/login";
import type { SettingsRepo } from "../db/settings-repo";
import { memoryOn } from "../settings/settings-values";
import type { ShipherdPaths } from "../paths";
import type { ExecText } from "../util/exec";
import { withPath } from "../util/env";
import { statecorePluginInstalled } from "../memory/plugin-check";
import { pathUnder, readMigrationMarker } from "../migrate/legacy-home";
import { hookBins, hookCommand, hookStatus, installHookBinary, installHooks, readSettings, uninstallHooks } from "./installer";

export interface HealthDeps {
  paths: ShipherdPaths;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  settings: SettingsRepo;
  /** 随 app 一起分发的 shipherd-hook，安装时复制到 paths.hookBin。 */
  bundledHookBin: string;
  /** 打包的 StateCore MCP（任务 7）；不给时视为不存在。 */
  memoryMcpScript?: string;
  readPath?: () => Promise<string>;
  run?: ExecText;
  log?: (msg: string, err?: unknown) => void;
  /** gh 装没装、登没登录（拿登录 shell 的 PATH 重新找 gh 再看）。不给时报 missing。 */
  gh?: (pathValue: string) => Promise<GhAuthState>;
  /** installHooks 装好当前版本的 hook 程序之后调用（健康页安装路径）；启动时的同类播种在 index.ts。抛错会被记日志并忽略。 */
  onHookBinCurrent?: () => void;
}

async function sha256(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** 两个文件内容一样：先比大小（不一样就不用算 hash），再比 sha256。 */
async function sameContent(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return ha === hb;
}

export class HealthService {
  private state: { path: string | null; pathValue: string } = { path: null, pathValue: "" };
  /** 最近一次探测到的可选参数；探测失败或还没探测时按 2.1.0 的假设：认 --model，不认 --effort。 */
  private optional: { model: boolean; effort: boolean } = { model: true, effort: false };
  /** 装着的 shipherd-hook 和随 app 分发的一样（认得 gate）。只有这时才给 session 挂合并总控的 gate hook。 */
  private binCurrent = false;
  /** 进行中的 syncHookBinary：安装要等它做完，两边写的是同一个临时文件。 */
  private binSync: Promise<boolean> = Promise.resolve(false);

  constructor(private readonly d: HealthDeps) {}

  private commandFile(): string {
    return handoffCommandPath(this.d.paths.claudeCommands);
  }

  /** 最近一次 refresh 得到的 claude 路径和登录 shell 的 PATH。 */
  claude(): { path: string | null; pathValue: string } {
    return this.state;
  }

  /** claude 认不认 --model / --effort（模型路由用）。 */
  claudeFlags(): { model: boolean; effort: boolean } {
    return this.optional;
  }

  /** 最近一次 refresh 探测到的 claude 版本（「发送反馈」预填用，BTL-254）；还没探测或失败是 null。 */
  claudeVersion(): string | null {
    return this.lastClaudeVersion;
  }
  private lastClaudeVersion: string | null = null;

  hookBinCurrent(): boolean {
    return this.binCurrent;
  }

  /**
   * 启动时：装着的 shipherd-hook 和随 app 分发的不一样（升级后还是旧版本，不认 gate，会把每条 Bash 命令当成普通 hook 事件）就换成新的。
   * 用户没装过的不替他装。永不抛错：换不了就不开 gate（最终审查 1）。返回 gate 能不能开。
   */
  syncHookBinary(): Promise<boolean> {
    this.binSync = this.binSync.then(() => this.syncOnce());
    return this.binSync;
  }

  private async syncOnce(): Promise<boolean> {
    const dest = this.d.paths.hookBin;
    await this.migrateLegacyHook();
    this.binCurrent = false;
    if (!existsSync(dest)) return false;
    try {
      if (await sameContent(this.d.bundledHookBin, dest)) {
        this.binCurrent = true;
        return true;
      }
    } catch (e) {
      this.d.log?.(`hook binary: could not compare ${dest} with the bundled one; merges are not checked`, e);
      return false;
    }
    this.d.log?.(`hook binary: ${dest} is out of date; replacing it with the bundled one`);
    try {
      await installHookBinary(this.d.bundledHookBin, dest);
      this.binCurrent = true;
    } catch (e) {
      this.d.log?.(`hook binary: could not replace ${dest}; merges are not checked`, e);
    }
    return this.binCurrent;
  }

  /**
   * BTL-260：改名前 Butler 装过 hook（settings.json 里有 butler-hook 条目）就替用户换成 shipherd-hook：
   * 用户装过等于同意过，不换的话升级后 hook 状态是 stale，gate、收件箱都断了。旧条目由 installHooks 去掉，不会新旧各一份。
   * 数据目录里还有旧的 bin/butler-hook（升级前起的 claude 还按旧路径调它）就把内容也换成新版本，新版本认得新旧两套环境变量。
   * 永不抛错。TODO(5.0)：保留一个大版本后删掉。
   */
  private legacyHookMigrated = false;
  /** 这次启动替用户把旧 hook 换掉了：和 syncHookBinary 并行跑的那次 refresh 可能读到换之前的设置，要再 refresh 一次。读一次就清掉。 */
  takeLegacyHookMigrated(): boolean {
    const v = this.legacyHookMigrated;
    this.legacyHookMigrated = false;
    return v;
  }

  /**
   * 要替用户换掉的条目必须是这个数据目录自己的：旧 butler-hook 在本目录的 bin 里（BUTLER_HOME 原样沿用的），
   * 或者 hook（新旧名字都算）在迁移标记记下的旧目录的 bin 里（~/.butler 搬过来的；以及上次没搬成、临时用旧目录装的）。
   * 另起的隔离实例（SHIPHERD_HOME 指向别处）不碰真实 settings 里别人的 hook：用户没点安装就不装。
   */
  private ownsLegacyHookEntries(settings: Record<string, unknown>): boolean {
    const home = this.d.paths.home;
    const marker = readMigrationMarker(home);
    const same = (a: string, b: string) => pathUnder(a, b) === "" || pathUnder(b, a) === "";
    return hookBins(settings).some(({ bin, legacy }) => {
      const binHome = path.dirname(path.dirname(bin));
      if (legacy && same(binHome, home)) return true;
      return marker !== null && same(marker.to, home) && same(binHome, marker.from);
    });
  }

  private async migrateLegacyHook(): Promise<void> {
    const bundled = this.d.bundledHookBin;
    const legacyBin = path.join(path.dirname(this.d.paths.hookBin), this.d.platform === "win32" ? "butler-hook.exe" : "butler-hook");
    try {
      if (existsSync(legacyBin) && !(await sameContent(bundled, legacyBin))) await installHookBinary(bundled, legacyBin);
    } catch (e) {
      this.d.log?.(`hook binary: could not refresh the legacy ${legacyBin}`, e);
    }
    try {
      if (!this.ownsLegacyHookEntries(await readSettings(this.d.paths.claudeSettings))) return;
      this.d.log?.(`hooks: replacing the legacy butler-hook entries in ${this.d.paths.claudeSettings} with ${this.d.paths.hookBin}`);
      await installHookBinary(bundled, this.d.paths.hookBin);
      await installHooks(this.d.paths.claudeSettings, this.d.paths.hookBin, this.d.platform);
      this.legacyHookMigrated = true;
    } catch (e) {
      this.d.log?.(`hooks: could not replace the legacy butler-hook entries`, e);
    }
  }

  /**
   * 启动时：装着的 /handoff 是 Shipherd 的旧版本（hash 对得上，stale）就换成当前版本（C1，和 syncHookBinary 一样）。
   * 用户自己的（conflict）、没装的不碰。永不抛错：换不了只记日志。
   */
  async syncHandoffCommand(): Promise<void> {
    const file = this.commandFile();
    try {
      if ((await handoffCommandStatus(file)) !== "stale") return;
      this.d.log?.(`handoff command: ${file} is out of date; replacing it with the current version`);
      await installHandoffCommand(file);
    } catch (e) {
      this.d.log?.(`handoff command: could not upgrade ${file}`, e);
    }
  }

  async refresh(): Promise<HealthReport> {
    const shellPath = await (this.d.readPath ?? (() => readLoginShellPath(this.d.platform, this.d.env)))();
    // 用户目录只从环境变量拿（测试给的 env 里没有就不回退，不会摸到真的用户目录）。
    const home = (this.d.platform === "win32" ? this.d.env.USERPROFILE : this.d.env.HOME) || undefined;
    const fallbacks = wellKnownClaudePaths(this.d.platform, { home, appData: this.d.env.APPDATA });
    const claudePath = locateClaude({ override: this.d.settings.get("claudePath"), pathValue: shellPath, platform: this.d.platform, fallbacks });
    // 在常见安装位置找到的（不在 PATH 上）：把它的目录加到 session 的 PATH 前面，session 里按名字调 claude 也找得到。
    const viaFallback = claudePath !== null && fallbacks.includes(claudePath) && this.d.settings.get("claudePath").trim() === "";
    const pathValue = viaFallback
      ? [(this.d.platform === "win32" ? path.win32 : path.posix).dirname(claudePath), shellPath].filter(Boolean).join(this.d.platform === "win32" ? ";" : ":")
      : shellPath;
    const [claude, gh] = await Promise.all([
      probeClaude(claudePath, withPath(this.d.env, pathValue), this.d.run),
      this.d.gh ? this.d.gh(pathValue).catch((): GhAuthState => "missing") : Promise.resolve<GhAuthState>("missing"),
    ]);
    const { paths } = this.d;
    const claudeLogin = claude.error === null
      ? await claudeLoginState({ claudeJson: paths.claudeJson, claudeConfigDir: paths.claudeConfigDir, claudeSettings: paths.claudeSettings, env: this.d.env })
      : null;
    this.state = { path: claudePath, pathValue };
    this.lastClaudeVersion = claude.version ?? null;
    this.optional = claude.error === null ? { model: claude.flags["--model"] === true, effort: claude.flags["--effort"] === true } : { model: true, effort: false };

    let hooks: HookStatus;
    let statecorePlugin = false;
    try {
      const claudeSettings = await readSettings(this.d.paths.claudeSettings);
      hooks = hookStatus(claudeSettings, hookCommand(this.d.paths.hookBin, this.d.platform));
      statecorePlugin = statecorePluginInstalled(claudeSettings);
    } catch {
      // 解析失败、是目录、没有权限等：一律视为 settings 不可用，不让启动失败。
      hooks = "settings_invalid";
    }
    let handoffCommand: HandoffCommandStatus;
    try {
      handoffCommand = await handoffCommandStatus(this.commandFile());
    } catch {
      // 读不了（权限、是目录）就当作不是 Shipherd 的文件，不去碰它。
      handoffCommand = "conflict";
    }
    return {
      claude,
      claudeLogin,
      gh,
      hooks,
      hookBinInstalled: existsSync(this.d.paths.hookBin),
      handoffCommand,
      shipherdHome: this.d.paths.home,
      claudeSettingsPath: this.d.paths.claudeSettings,
      memory: {
        enabled: memoryOn(this.d.settings),
        dataDir: this.d.paths.statecore,
        mcpBundle: !!this.d.memoryMcpScript && existsSync(this.d.memoryMcpScript),
        statecorePlugin,
      },
    };
  }

  async installHooks(): Promise<HealthReport> {
    await this.binSync;
    await installHookBinary(this.d.bundledHookBin, this.d.paths.hookBin);
    this.binCurrent = true;
    try {
      this.d.onHookBinCurrent?.();
    } catch (e) {
      this.d.log?.("onHookBinCurrent failed", e);
    }
    await installHooks(this.d.paths.claudeSettings, this.d.paths.hookBin, this.d.platform);
    try {
      // 用户自己的 handoff.md 会得到 conflict（不覆盖，不抛错）；写入失败也不能让整个安装白做、健康页不刷新。
      await installHandoffCommand(this.commandFile());
    } catch {
      /* refresh 会如实报告 handoffCommand 状态 */
    }
    return this.refresh();
  }

  async uninstallHooks(): Promise<HealthReport> {
    await uninstallHooks(this.d.paths.claudeSettings);
    await uninstallHandoffCommand(this.commandFile());
    return this.refresh();
  }
}
