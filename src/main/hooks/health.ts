import { existsSync } from "node:fs";
import type { HealthReport, HookStatus } from "../../shared/types";
import { probeClaude } from "../claude/capabilities";
import { locateClaude, readLoginShellPath } from "../claude/locate";
import type { SettingsRepo } from "../db/settings-repo";
import type { ButlerPaths } from "../paths";
import type { ExecText } from "../util/exec";
import { withPath } from "../util/env";
import { hookCommand, hookStatus, installHookBinary, installHooks, readSettings, uninstallHooks } from "./installer";

export interface HealthDeps {
  paths: ButlerPaths;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  settings: SettingsRepo;
  /** 随 app 一起分发的 butler-hook，安装时复制到 paths.hookBin。 */
  bundledHookBin: string;
  readPath?: () => Promise<string>;
  run?: ExecText;
}

export class HealthService {
  private state: { path: string | null; pathValue: string } = { path: null, pathValue: "" };

  constructor(private readonly d: HealthDeps) {}

  /** 最近一次 refresh 得到的 claude 路径和登录 shell 的 PATH。 */
  claude(): { path: string | null; pathValue: string } {
    return this.state;
  }

  async refresh(): Promise<HealthReport> {
    const pathValue = await (this.d.readPath ?? (() => readLoginShellPath(this.d.platform, this.d.env)))();
    const path = locateClaude({ override: this.d.settings.get("claudePath"), pathValue, platform: this.d.platform });
    const claude = await probeClaude(path, withPath(this.d.env, pathValue), this.d.run);
    this.state = { path, pathValue };

    let hooks: HookStatus;
    try {
      hooks = hookStatus(await readSettings(this.d.paths.claudeSettings), hookCommand(this.d.paths.hookBin, this.d.platform));
    } catch {
      // 解析失败、是目录、没有权限等：一律视为 settings 不可用，不让启动失败。
      hooks = "settings_invalid";
    }
    return {
      claude,
      hooks,
      hookBinInstalled: existsSync(this.d.paths.hookBin),
      butlerHome: this.d.paths.home,
      claudeSettingsPath: this.d.paths.claudeSettings,
    };
  }

  async installHooks(): Promise<HealthReport> {
    await installHookBinary(this.d.bundledHookBin, this.d.paths.hookBin);
    await installHooks(this.d.paths.claudeSettings, this.d.paths.hookBin, this.d.platform);
    return this.refresh();
  }

  async uninstallHooks(): Promise<HealthReport> {
    await uninstallHooks(this.d.paths.claudeSettings);
    return this.refresh();
  }
}
