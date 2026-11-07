import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { HandoffCommandStatus, HealthReport, HookStatus } from "../../shared/types";
import { handoffCommandPath, handoffCommandStatus, installHandoffCommand, uninstallHandoffCommand } from "../handoff/command";
import { probeClaude } from "../claude/capabilities";
import { locateClaude, readLoginShellPath } from "../claude/locate";
import type { SettingsRepo } from "../db/settings-repo";
import { memoryOn } from "../settings/settings-values";
import type { ButlerPaths } from "../paths";
import type { ExecText } from "../util/exec";
import { withPath } from "../util/env";
import { statecorePluginInstalled } from "../memory/plugin-check";
import { hookCommand, hookStatus, installHookBinary, installHooks, readSettings, uninstallHooks } from "./installer";

export interface HealthDeps {
  paths: ButlerPaths;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  settings: SettingsRepo;
  /** 随 app 一起分发的 butler-hook，安装时复制到 paths.hookBin。 */
  bundledHookBin: string;
  /** 打包的 StateCore MCP（任务 7）；不给时视为不存在。 */
  memoryMcpScript?: string;
  readPath?: () => Promise<string>;
  run?: ExecText;
  log?: (msg: string, err?: unknown) => void;
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
  /** 装着的 butler-hook 和随 app 分发的一样（认得 gate）。只有这时才给 session 挂合并总控的 gate hook。 */
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

  hookBinCurrent(): boolean {
    return this.binCurrent;
  }

  /**
   * 启动时：装着的 butler-hook 和随 app 分发的不一样（升级后还是旧版本，不认 gate，会把每条 Bash 命令当成普通 hook 事件）就换成新的。
   * 用户没装过的不替他装。永不抛错：换不了就不开 gate（最终审查 1）。返回 gate 能不能开。
   */
  syncHookBinary(): Promise<boolean> {
    this.binSync = this.binSync.then(() => this.syncOnce());
    return this.binSync;
  }

  private async syncOnce(): Promise<boolean> {
    const dest = this.d.paths.hookBin;
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
   * 启动时：装着的 /handoff 是 Butler 的旧版本（hash 对得上，stale）就换成当前版本（C1，和 syncHookBinary 一样）。
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
    const pathValue = await (this.d.readPath ?? (() => readLoginShellPath(this.d.platform, this.d.env)))();
    const path = locateClaude({ override: this.d.settings.get("claudePath"), pathValue, platform: this.d.platform });
    const claude = await probeClaude(path, withPath(this.d.env, pathValue), this.d.run);
    this.state = { path, pathValue };

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
      // 读不了（权限、是目录）就当作不是 Butler 的文件，不去碰它。
      handoffCommand = "conflict";
    }
    return {
      claude,
      hooks,
      hookBinInstalled: existsSync(this.d.paths.hookBin),
      handoffCommand,
      butlerHome: this.d.paths.home,
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
