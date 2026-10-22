import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { S } from "../src/renderer/src/strings";

export const ROOT = resolve(__dirname, "..");

export interface Sandbox {
  dir: string;
  /** 故意带空格（Review Focus 1）：--mcp-config 路径和 hook 路径都会有空格。 */
  butlerHome: string;
  claudeConfigDir: string;
  claudePath: string;
  repo: string;
  /** 假 claude 的运行记录（CI 失败时上传）。 */
  fakeLog: string;
}

const isWin = process.platform === "win32";
/** 沙盒里的 HOME、PATH 目录（只放假 claude）和假登录 shell。 */
const homeDir = (dir: string) => join(dir, "home");
const binDir = (dir: string) => join(dir, "bin");
const loginShell = (dir: string) => join(dir, "fake-login-shell");

/** 这个 worker 启动过的 Butler 和建过的沙盒：cleanup() 用来收尾。 */
const launched = new Map<ElectronApplication, ChildProcess>();
const sandboxDirs = new Set<string>();

/** Windows 上用 npm 的 cmd-shim 格式包装假 claude，走一遍任务 3 的 shim 解析。 */
const NPM_STYLE_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\fake-claude.cjs" %*',
  "",
].join("\r\n");

/**
 * 假登录 shell（Ruling P5-PF5）：Butler 用 `$SHELL -ilc '<命令>'` 读登录 PATH，真的登录 shell 会读开发者的 shell 配置，
 * PATH 里就有真 claude，向导保存假路径之前的健康检查会执行它。这里不读任何配置，用沙盒的环境执行最后一个参数。
 */
const FAKE_LOGIN_SHELL = '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n';

/** 每个测试一套全新的临时目录：BUTLER_HOME、CLAUDE_CONFIG_DIR、HOME、假 claude、假登录 shell、带一个提交的 git 仓库。 */
export function makeSandbox(): Sandbox {
  for (const f of ["out/main/index.js", "build/memory-mcp/statecore-mcp.cjs", isWin ? "build/hook/butler-hook.exe" : "build/hook/butler-hook"]) {
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing: run pnpm build && pnpm build:hook before pnpm e2e`);
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "butler-e2e-")));
  sandboxDirs.add(dir);
  const butlerHome = join(dir, "Butler Home");
  const claudeConfigDir = join(dir, "claude-config");
  const bin = binDir(dir);
  mkdirSync(claudeConfigDir, { recursive: true });
  mkdirSync(bin);
  mkdirSync(homeDir(dir));
  copyFileSync(join(ROOT, "e2e", "fake-claude", "fake-claude.cjs"), join(bin, "fake-claude.cjs"));
  let claudePath: string;
  if (isWin) {
    claudePath = join(bin, "claude.cmd");
    writeFileSync(claudePath, NPM_STYLE_SHIM);
  } else {
    claudePath = join(bin, "claude");
    // 写死这次运行用的 node：沙盒的 PATH 里没有 node。
    writeFileSync(claudePath, `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(claudePath, 0o755);
    writeFileSync(loginShell(dir), FAKE_LOGIN_SHELL);
    chmodSync(loginShell(dir), 0o755);
  }
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "e2e\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, butlerHome, claudeConfigDir, claudePath, repo, fakeLog: join(dir, "fake-claude.log") };
}

/** Windows 的 PATH：假 claude，再加系统目录和 node、git 所在的目录（cmd-shim 要 node，Butler 要 git.exe）。 */
function windowsPath(s: Sandbox): string {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const where = (name: string) => {
    const r = spawnSync("where", [name], { encoding: "utf8" });
    const first = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : "";
    return first ? [dirname(first)] : [];
  };
  return [binDir(s.dir), dirname(process.execPath), ...where("git.exe"), join(root, "System32"), root, join(root, "System32", "Wbem")].join(";");
}

/** 启动给 Butler 的环境：外层会话的变量都去掉，HOME / PATH / SHELL / 数据目录全部指向沙盒。 */
function sandboxEnv(s: Sandbox): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // 在 Claude Code 里跑测试时，去掉外层会话的标记变量；ELECTRON_RENDERER_URL 会让 Butler 去连 dev server。
    if (v === undefined || k === "CLAUDECODE" || k === "CLAUDE_PID" || k.startsWith("CLAUDE_CODE_") || k.startsWith("ELECTRON_")) continue;
    if (/^path$/i.test(k)) continue;
    env[k] = v;
  }
  env.HOME = homeDir(s.dir);
  if (isWin) {
    env.Path = windowsPath(s);
  } else {
    env.PATH = [binDir(s.dir), "/usr/bin", "/bin"].join(delimiter);
    env.SHELL = loginShell(s.dir);
  }
  env.BUTLER_HOME = s.butlerHome;
  env.CLAUDE_CONFIG_DIR = s.claudeConfigDir;
  env.FAKE_CLAUDE_LOG = s.fakeLog;
  return env;
}

/**
 * 守卫（Ruling P5-PF5）：按 Butler 的找法（登录 shell 的 PATH，Windows 上直接用 Path）在沙盒环境里找 claude，
 * 能找到的只能是这个沙盒的假 claude，否则整个测试失败，不启动 Butler。
 */
export function assertOnlyFakeClaude(s: Sandbox, env: Record<string, string>): void {
  let pathValue: string;
  let names: string[];
  if (isWin) {
    pathValue = env.Path;
    names = ["claude.exe", "claude.cmd", "claude.bat"];
  } else {
    pathValue = execFileSync(env.SHELL, ["-ilc", 'printf %s "$PATH"'], { env, encoding: "utf8", timeout: 5000 });
    names = ["claude"];
  }
  const found = pathValue
    .split(isWin ? ";" : ":")
    .filter(Boolean)
    .flatMap((d) => names.map((n) => join(d, n)))
    .filter((p) => existsSync(p));
  expect(found, `claude reachable from the sandbox PATH ${pathValue}`).toEqual([s.claudePath]);
  for (const key of ["HOME", "BUTLER_HOME", "CLAUDE_CONFIG_DIR"]) expect(env[key].startsWith(s.dir), `${key}=${env[key]}`).toBe(true);
}

/** 启动 Butler（`electron .`，用 pnpm build 的产物，不用 dev server），收集渲染进程的控制台输出。 */
export async function launch(s: Sandbox): Promise<{ app: ElectronApplication; page: Page; console: string[] }> {
  const env = sandboxEnv(s);
  assertOnlyFakeClaude(s, env);
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  // 进程对象要现在拿：app 关掉之后 app.process() 就不能用了。
  launched.set(app, app.process());
  const page = await app.firstWindow();
  const messages: string[] = [];
  page.on("console", (m) => messages.push(m.text()));
  return { app, page, console: messages };
}

/** 强杀 Butler：Windows 上连同它的子进程树（终端里的假 claude）。 */
function kill(child: ChildProcess): void {
  if (isWin && child.pid !== undefined) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/**
 * 每个 spec 都要 `test.afterEach(cleanup)`：还开着的 Butler 先正常退出，15 秒退不掉就强杀；
 * 再按沙盒目录清掉剩下的进程（假 claude、hook）——命令行里带这个随机目录的只可能是本测试启动的进程。
 * 测试通过就删掉沙盒（hook 程序一份就有一百多 MB），失败时留着看日志。
 */
export async function cleanup(): Promise<void> {
  for (const [app, child] of launched) {
    if (running(child)) await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))]);
    if (running(child)) kill(child);
    launched.delete(app);
  }
  const info = test.info();
  const passed = info.status === info.expectedStatus;
  for (const dir of sandboxDirs) {
    if (!isWin) spawnSync("pkill", ["-KILL", "-f", dir]);
    if (passed) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    else console.log(`sandbox kept for debugging: ${dir}`);
    sandboxDirs.delete(dir);
  }
}

/** 名字正好是 term 的 <dt> 后面那个 <dd>（健康检查的键值表）。 */
export function kvValue(page: Page, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp(`^${escaped}$`);
  return page.locator("dt").filter({ hasText: exact }).locator("xpath=following-sibling::dd[1]");
}

/** 走完首次启动向导：填假 claude 的路径、安装 hook、其余步骤跳过。 */
export async function completeWizard(page: Page, s: Sandbox): Promise<void> {
  await expect(page.getByTestId("wizard")).toBeVisible();
  await page.getByPlaceholder(S.generalPlaceholders.claudePath, { exact: true }).fill(s.claudePath);
  await page.getByRole("button", { name: S.save, exact: true }).click();
  await expect(kvValue(page, S.claudePath)).toHaveText(s.claudePath);
  // 假 claude 的 --version（真 claude 不会是这个版本号）。
  await expect(kvValue(page, S.claudeVersion)).toHaveText("2.1.306");
  const next = page.getByRole("button", { name: S.wizardNext, exact: true });
  await expect(next).toBeEnabled();
  await next.click();
  await page.getByRole("button", { name: S.installHooks, exact: true }).click();
  await expect(kvValue(page, S.hooks)).toHaveText(S.hookStatus.installed);
  await expect(kvValue(page, S.handoffCommand)).toHaveText(S.handoffCommandStatus.installed);
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: S.wizardNext, exact: true }).click();
  await page.getByRole("button", { name: S.wizardFinish, exact: true }).click();
  await expect(page.getByTestId("wizard")).toHaveCount(0);
}

/** 当前显示的终端里的文字（xterm 的 DOM 渲染器）。 */
export async function terminalText(page: Page): Promise<string> {
  return page.locator(".terminal-wrap:visible .xterm-rows").innerText();
}
