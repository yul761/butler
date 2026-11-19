import { _electron as electron, test as base, expect, type ElectronApplication, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { S, type UiStrings } from "../src/renderer/src/strings";

export const ROOT = resolve(__dirname, "..");

export interface Sandbox {
  dir: string;
  /** 故意带空格（Review Focus 1）：--mcp-config 路径和 hook 路径都会有空格。 */
  butlerHome: string;
  claudeConfigDir: string;
  claudePath: string;
  repo: string;
  /** 第二个仓库（多仓库 ticket 用）。 */
  apiRepo: string;
  /** 假 claude 的运行记录（CI 失败时上传）。 */
  fakeLog: string;
  /**
   * 传给 Butler 的 BUTLER_LANG（设计文档 2026-10-26）：默认 zh，测试按中文文案找界面元素，和这台机器的系统语言无关。
   * null 表示不设，让设置（和系统语言）决定。
   */
  lang: "zh" | "en" | null;
  /** 这个测试额外传给 Butler 的环境变量（比如调短活动监视的间隔）。 */
  env: Record<string, string>;
  /** 假 gh 的 fixture 文件；null：这个沙盒没有 gh（makeSandbox 没给 gh）。 */
  ghFixture: string | null;
  /** 假 gh 的调用记录：每行一次调用的参数（JSON 数组）。 */
  ghLog: string;
  /** 换掉假 gh 的 fixture（假 gh 每次调用都重新读）；沙盒还没有 gh 就装上，下次启动 Butler 时生效。 */
  setGh(fixture: FakeGhFixture): void;
  /**
   * 假 claude 复盘分析的模式（ok、fail、limit:<秒级时间戳>，见 fake-claude.cjs）：写进模式文件，假 claude 每次分析都重新读，测试中途可以改。
   * 同时把 FAKE_CLAUDE_LESSONS_FILE 设进 s.env：env 在启动 Butler 时才传过去，所以第一次要在启动之前调；之后整个换掉 s.env 会把它丢掉。
   */
  lessonsMode(mode: string): void;
}

/** gh pr list --head <分支> --state all --json … 的一项（gh 的字段名）。 */
export interface BranchPrFixture {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  createdAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
}

/** gh pr view <链接> --json … 的结果（src/main/tickets/gh.ts 的 PR_FIELDS）。 */
export interface PrViewFixture extends BranchPrFixture {
  isDraft: boolean;
  reviewDecision: string;
  headRefOid: string;
  statusCheckRollup: unknown[];
  author: { login: string };
  reviews: unknown[];
  comments: unknown[];
  commits: unknown[];
  /** gh pr view <号> 给复盘分析的字段（prLessonData）。 */
  title?: string;
  body?: string;
  /** 进度页（ws-b）用：叠放树、卡在谁手上、PR 表分组。 */
  baseRefName?: string;
  labels?: { name: string }[];
  reviewRequests?: ({ login: string } | { slug: string })[];
  mergeable?: string;
  mergeStateStatus?: string;
}

/** 假 gh（e2e/fake-gh/fake-gh.cjs）的数据：branches 按分支名，prs 按 prUrlKey 形式的链接（小写、没有末尾斜杠；gh pr view <号> 取链接以 /pull/<号> 结尾的第一项）。 */
export interface FakeGhFixture {
  branches: Record<string, BranchPrFixture[]>;
  prs: Record<string, PrViewFixture>;
  /** gh pr create 打印的新 PR 链接；没有时 gh pr create 是不支持的调用。 */
  created?: string;
  /** 评论闭环（工作流 I）：PR 号 → GraphQL 的 review thread 节点。 */
  threads?: Record<string, unknown[]>;
  /** CI 分类（工作流 I）：run id → gh run view --json 的结果；run id → --log-failed 的输出。 */
  runs?: Record<string, unknown>;
  logs?: Record<string, string>;
  /** gh api …/compare/<base>...<head> 的文件。 */
  compare?: { filename: string; patch?: string }[];
  /** 栈（工作流 K）：gh pr list --state open（自动检测栈）的结果；gh issue create 打印的链接。 */
  open?: PrViewFixture[];
  issueCreated?: string;
}

/** 假 gh 的调用记录（每行一次调用的参数）。 */
export function ghCalls(s: Sandbox): string[][] {
  if (!existsSync(s.ghLog)) return [];
  return readFileSync(s.ghLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown).filter((v): v is string[] => Array.isArray(v));
}

/**
 * 用假 gh 的测试给仓库设的 origin（makeGitRepo 的第二个参数，slug acme/app）：fixture 里的 PR 链接都在这个仓库。
 * 不设在沙盒自带的 repo 上：feature、epic 的工作区建在所选上层目录的旁边（<目录>-features），上层目录要是沙盒里的子目录，不能是沙盒本身。
 */
export const FAKE_GH_ORIGIN = "https://github.com/acme/app.git";

export interface SandboxOptions {
  /** 给了就在沙盒的 PATH 里装假 gh。不支持 Windows。 */
  gh?: FakeGhFixture;
}

const isWin = process.platform === "win32";
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 沙盒里的 HOME（Windows 上也是用户目录）、临时目录、PATH 目录（只放假 claude）和假登录 shell。 */
const homeDir = (dir: string) => join(dir, "home");
const tempDir = (dir: string) => join(dir, "tmp");
const binDir = (dir: string) => join(dir, "bin");
const loginShell = (dir: string) => join(dir, "fake-login-shell");

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

/** 在 path 建一个带一个提交、当前分支为 main 的 git 仓库（目录会被建出来，可以多层）；给了 origin 就加上这个 remote（只加，不 fetch）。 */
export function makeGitRepo(path: string, origin?: string): string {
  mkdirSync(path, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: path, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(path, "README.md"), "e2e\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  if (origin) git("remote", "add", "origin", origin);
  return path;
}

/** 在沙盒的 PATH 目录里装假 gh：和假 claude 一样是写死 node 的 sh 包装（Windows 上 resolveGh 只认 gh.exe，不支持）。 */
function installFakeGh(dir: string): void {
  if (isWin) throw new Error("the fake gh is an sh wrapper: not supported on Windows (resolveGh only accepts gh.exe)");
  const bin = binDir(dir);
  copyFileSync(join(ROOT, "e2e", "fake-gh", "fake-gh.cjs"), join(bin, "fake-gh.cjs"));
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-gh.cjs")}" "$@"\n`);
  chmodSync(gh, 0o755);
}

/** 一套全新的临时目录：BUTLER_HOME、CLAUDE_CONFIG_DIR、HOME、TMPDIR、假 claude、假登录 shell、两个各带一个提交的 git 仓库；要 gh 时再加假 gh。 */
function createSandbox(opts: SandboxOptions = {}): Sandbox {
  for (const f of ["out/main/index.js", "build/memory-mcp/statecore-mcp.cjs", isWin ? "build/hook/butler-hook.exe" : "build/hook/butler-hook"]) {
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing: run pnpm build && pnpm build:hook before pnpm e2e:only`);
  }
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "butler-e2e-")));
  const butlerHome = join(dir, "Butler Home");
  const claudeConfigDir = join(dir, "claude-config");
  const bin = binDir(dir);
  mkdirSync(claudeConfigDir, { recursive: true });
  mkdirSync(bin);
  mkdirSync(homeDir(dir));
  mkdirSync(tempDir(dir));
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
  const repo = makeGitRepo(join(dir, "repo"));
  const apiRepo = makeGitRepo(join(dir, "api"));
  const s: Sandbox = {
    dir, butlerHome, claudeConfigDir, claudePath, repo, apiRepo, fakeLog: join(dir, "fake-claude.log"), lang: "zh", env: {},
    ghFixture: null,
    ghLog: join(dir, "fake-gh.log"),
    setGh(fixture) {
      if (s.ghFixture === null) {
        installFakeGh(dir);
        s.ghFixture = join(dir, "fake-gh.json");
      }
      writeFileSync(s.ghFixture, JSON.stringify(fixture, null, 2));
    },
    lessonsMode(mode) {
      const file = join(dir, "fake-claude-lessons");
      writeFileSync(file, mode);
      s.env.FAKE_CLAUDE_LESSONS_FILE = file;
    },
  };
  if (opts.gh) s.setGh(opts.gh);
  return s;
}

/**
 * Windows 的 PATH：假 claude，再加 node、git 所在的目录（cmd-shim 要 node，Butler 要 git.exe）和系统目录。
 * 注意：用 nvm-windows 或 volta 时，node 所在的目录里往往也有全局安装的真 claude.cmd。守卫会因此直接失败（不会去执行它）；
 * 这种机器上请让 node 来自一个没有 claude 的目录（例如官方安装包的 C:\Program Files\nodejs）再跑 E2E。
 */
function windowsPath(s: Sandbox): string {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const where = (name: string) => {
    const r = spawnSync("where", [name], { encoding: "utf8" });
    const first = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : "";
    return first ? [dirname(first)] : [];
  };
  return [binDir(s.dir), dirname(process.execPath), ...where("git.exe"), join(root, "System32"), root, join(root, "System32", "Wbem")].join(";");
}

/** 原样传给 Butler 的变量（白名单，Ruling P5-PF5）：语言和显示。其余（token、云凭据、git 配置……）一律不传。 */
const PASS_THROUGH = /^(LANG|LANGUAGE|LC_[A-Z_]+|DISPLAY)$/;
/**
 * Windows 上进程正常运行必需的系统变量。PSModulePath 也算：真实的 Windows 进程都从资源管理器继承它，
 * 没有它时 Windows PowerShell 5.1 一加载模块（Get-CimInstance、Add-Type）就卡住，直到 Butler 15 秒的超时把它杀掉，
 * 内存采样和 EcoQoS 一次都成功不了（2026-11-18 在 windows-latest 上实测）。
 */
const WINDOWS_SYSTEM = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "SystemDrive", "PSModulePath"];

/** 启动给 Butler 的环境：只有白名单里的变量；HOME / 用户目录 / 临时目录 / PATH / SHELL / 数据目录全部指向沙盒。 */
function sandboxEnv(s: Sandbox): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (PASS_THROUGH.test(k) || (isWin && WINDOWS_SYSTEM.some((w) => w.toLowerCase() === k.toLowerCase())))) env[k] = v;
  }
  const home = homeDir(s.dir);
  const tmp = tempDir(s.dir);
  env.HOME = home;
  if (isWin) {
    const { root } = parse(home);
    env.USERPROFILE = home;
    env.HOMEDRIVE = root.replace(/[\\/]+$/, "");
    env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
    env.APPDATA = join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = join(home, "AppData", "Local");
    env.TEMP = tmp;
    env.TMP = tmp;
    env.Path = windowsPath(s);
  } else {
    env.TMPDIR = tmp;
    env.PATH = [binDir(s.dir), "/usr/bin", "/bin"].join(":");
    env.SHELL = loginShell(s.dir);
  }
  env.BUTLER_HOME = s.butlerHome;
  env.CLAUDE_CONFIG_DIR = s.claudeConfigDir;
  env.FAKE_CLAUDE_LOG = s.fakeLog;
  if (s.ghFixture !== null) {
    env.FAKE_GH_FIXTURE = s.ghFixture;
    env.FAKE_GH_LOG = s.ghLog;
  }
  // 窗口在后台打开，不抢焦点（用户反馈 2026-10-28：跑测试时正在别处打字被打断）。
  env.BUTLER_BACKGROUND_WINDOWS = "1";
  // 开新 session 前的内存准入（工作流 W）不看 CI 机器的真实内存（macOS runner 只有 7 GB 左右，开着 Electron 就不够了）：
  // 定死一个够开很多个的读数。测「内存不够」的 spec 在 s.env 里换成小的。
  env.BUTLER_E2E_AVAILABLE_MB = "65536";
  if (s.lang) env.BUTLER_LANG = s.lang;
  return { ...env, ...s.env };
}

/**
 * 假 gh 不认的调用（fake-gh.cjs 记的 {"unsupported": 参数} 行）的参数。用假 gh 的测试在结尾断言它是空的：
 * 产品新调了一条假 gh 不认的命令时，测试会失败，而不是把它当成"gh 出错"悄悄吞掉。
 */
export function unsupportedGhCalls(s: Sandbox): string[][] {
  if (!existsSync(s.ghLog)) return [];
  return readFileSync(s.ghLog, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => (JSON.parse(l) as { unsupported: string[] }).unsupported);
}

/**
 * 守卫（Ruling P5-PF5），每次启动前执行，不通过就不启动 Butler：
 * 按 Butler 的找法（登录 shell 的 PATH，Windows 上直接用 Path）在沙盒环境里找 claude，能找到的只能是这个沙盒的假 claude；
 * 用这套环境跑 node，os.homedir() / os.tmpdir() 都必须落在沙盒里（Windows 上看的是 USERPROFILE / TEMP）。
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
  const probe = 'const os = require("node:os"); process.stdout.write(JSON.stringify([os.homedir(), os.tmpdir()]))';
  const dirs = JSON.parse(execFileSync(process.execPath, ["-e", probe], { env, encoding: "utf8", timeout: 10_000 })) as string[];
  for (const d of [...dirs, env.BUTLER_HOME, env.CLAUDE_CONFIG_DIR]) expect(d.startsWith(s.dir), `${d} is outside the sandbox ${s.dir}`).toBe(true);
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  console: string[];
}

/** 一个测试里建过的沙盒和启动过的 Butler 进程：测试结束后由 e2eCleanup 收尾。 */
interface Tracker {
  sandboxes: Sandbox[];
  apps: { app: ElectronApplication; child: ChildProcess }[];
}

/** 启动 Butler（`electron .`，用 pnpm build 的产物，不用 dev server），收集渲染进程的控制台输出。 */
async function launchButler(s: Sandbox, tracker: Tracker): Promise<Launched> {
  const env = sandboxEnv(s);
  assertOnlyFakeClaude(s, env);
  // 多带一个 Chromium 不认识的开关：Electron 主进程的命令行里就有沙盒目录，收尾时能按目录找到它。
  const app = await electron.launch({ args: [ROOT, `--butler-e2e-sandbox=${s.dir}`], cwd: ROOT, env });
  // 先登记再等窗口（等窗口超时也能收尾）；进程对象要现在拿，app 关掉之后 app.process() 就不能用了。
  tracker.apps.push({ app, child: app.process() });
  const page = await app.firstWindow();
  const messages: string[] = [];
  page.on("console", (m) => messages.push(m.text()));
  return { app, page, console: messages };
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** 关掉 Butler：先正常退出，15 秒退不掉就强杀。 */
async function closeApp(app: ElectronApplication, child: ChildProcess): Promise<void> {
  if (!running(child)) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([app.close().catch(() => undefined), new Promise((r) => (timer = setTimeout(r, 15_000)))]);
  clearTimeout(timer);
  if (running(child)) child.kill("SIGKILL");
}

/**
 * 假 claude 写的 tasks 目录在真实的系统临时目录里（Butler 只看那里），不在沙盒里。
 * 目录名是工作目录换成连字符（claude-<uid>/<工作目录>/...），带这个随机目录名的只可能是本测试的。
 */
function removeClaudeTmp(dir: string): void {
  if (isWin) return;
  const root = join(process.platform === "darwin" ? "/private/tmp" : "/tmp", `claude-${process.getuid!()}`);
  const mark = basename(dir).replace(/[^A-Za-z0-9]/g, "-");
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) if (name.includes(mark)) rmSync(join(root, name), { recursive: true, force: true });
}

/** 杀掉命令行或可执行文件在沙盒目录里的所有进程（Butler、终端里的假 claude、hook）：带这个随机目录的只可能是本测试启动的。 */
function sweep(dir: string): void {
  if (isWin) {
    const script =
      "$d = $env:BUTLER_E2E_SWEEP; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and " +
      "(($_.CommandLine -and $_.CommandLine.Contains($d)) -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($d))) } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, BUTLER_E2E_SWEEP: dir }, stdio: "ignore", timeout: 60_000 });
  } else {
    spawnSync("pkill", ["-KILL", "-f", escapeRe(dir)], { stdio: "ignore" });
  }
}

/**
 * 测试结束（通过、失败、超时都一样）：关掉 Butler，按目录清掉剩下的进程，再处理沙盒。
 * 通过就整个删掉；失败时只删 hook 程序的副本（一份一百多 MB），留下日志、数据库和假 claude 的记录。
 */
async function teardown(tracker: Tracker, info: TestInfo): Promise<void> {
  for (const { app, child } of tracker.apps) await closeApp(app, child);
  const passed = info.status === info.expectedStatus;
  for (const s of tracker.sandboxes) {
    sweep(s.dir);
    removeClaudeTmp(s.dir);
    // Windows 上刚被杀的进程可能还占着文件：rmSync 遇到 EBUSY / EPERM 会重试。
    const rm = (p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (passed) {
      rm(s.dir);
    } else {
      rm(join(s.butlerHome, "bin", isWin ? "butler-hook.exe" : "butler-hook"));
      console.log(`sandbox kept for debugging: ${s.dir}`);
    }
  }
}

/**
 * E2E 的 test：spec 从这里 import { test, expect }。
 * - makeSandbox(opts?)：建一个新沙盒（一个测试里可以建多个）；opts.gh 给了就带假 gh，之后用 s.setGh 换数据；
 * - launch(s)：在沙盒里启动 Butler（同一个沙盒可以先关再启动，测重启）；
 * 测试结束后自动收尾（e2eCleanup 是自动 fixture，不用每个 spec 写 afterEach，也不用 try/finally）。
 */
export const test = base.extend<{ e2eCleanup: Tracker; makeSandbox: (opts?: SandboxOptions) => Sandbox; launch: (s: Sandbox) => Promise<Launched> }>({
  e2eCleanup: [
    // Playwright 要求第一个参数写成解构形式。
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, info) => {
      const tracker: Tracker = { sandboxes: [], apps: [] };
      await use(tracker);
      await teardown(tracker, info);
    },
    { auto: true },
  ],
  makeSandbox: async ({ e2eCleanup }, use) => {
    await use((opts) => {
      const s = createSandbox(opts);
      e2eCleanup.sandboxes.push(s);
      return s;
    });
  },
  launch: async ({ e2eCleanup }, use) => {
    await use((s) => launchButler(s, e2eCleanup));
  },
});
export { expect };

/**
 * feature、epic、Butler 总控页上面的 tab：名字开头是 name 的那个（后面跟着数量和记号）。
 * openTab 只在它没选中时点：再点一下当前 tab 会收起。
 */
export const pageTab = (page: Page, name: string) =>
  page.locator(".page-tabs-bar").getByRole("tab", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
export async function openTab(page: Page, name: string): Promise<void> {
  const tab = pageTab(page, name);
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** 名字正好是 term 的 <dt> 后面那个 <dd>（健康检查的键值表）。 */
export function kvValue(page: Page, term: string) {
  const exact = new RegExp(`^${escapeRe(term)}$`);
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
  // 假 claude 的 --help 列全了 Butler 要的参数（没有“缺少的参数”这一行）。
  await expect(kvValue(page, S.missingFlags)).toHaveCount(0);
  const next = page.getByRole("button", { name: S.wizardNext, exact: true });
  await expect(next).toBeEnabled();
  await next.click();
  await page.getByRole("button", { name: S.installHooks, exact: true }).click();
  await expect(kvValue(page, S.hooks)).toHaveText(S.hookStatus.installed);
  await expect(kvValue(page, S.handoffCommand)).toHaveText(S.handoffCommandStatus.installed);
  // tracker → 隐私 → 权限档案（ws-j）→ 完成。
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: S.wizardNext, exact: true }).click();
  await page.getByRole("button", { name: S.wizardFinish, exact: true }).click();
  await expect(page.getByTestId("wizard")).toHaveCount(0);
}

/** 当前显示的终端里的文字（xterm 的 DOM 渲染器）。 */
export async function terminalText(page: Page): Promise<string> {
  return page.locator(".terminal-wrap:visible .xterm-rows").innerText();
}

/** 点 open 打开新建对话框（epic 或 feature），选上一层目录，下面的两个仓库都用。建好后停在新页面上。 */
export async function create(page: Page, open: Locator, label: string, name: string, dir: string, T: UiStrings = S): Promise<void> {
  await open.click();
  await page.getByLabel(label, { exact: true }).fill(name);
  const box = page.getByRole("textbox", { name: `${T.repo} ${T.pick}`, exact: true });
  await box.fill(dir);
  await box.blur();
  await expect(page.getByText(T.subReposFound(2), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: T.create, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

/** 在当前 feature 页上建 ticket，只用一个仓库；建完停在 ticket 页。 */
export async function newTicket(page: Page, key: string, repo: string, other: string): Promise<void> {
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
  await page.locator(".modal").getByRole("checkbox", { name: repo, exact: true }).check();
  await page.locator(".modal").getByRole("checkbox", { name: other, exact: true }).uncheck();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
}

/**
 * 设置 →「评论与 CI」（工作流 I）：在全局这一层把 values 里的键设上（布尔、枚举是下拉框，其余是输入框），保存；
 * external 里的对外动作开关一并打开。
 */
export async function setLoopPolicy(page: Page, values: Record<string, string>, external: readonly string[] = []): Promise<void> {
  await page.locator(".sidebar").getByRole("button", { name: S.settings, exact: true }).click();
  await page.getByTestId("settings-tab-loop").click();
  const editor = page.getByTestId("loop-policy-editor");
  await expect(editor.getByTestId("loop-row-comments.enabled")).toBeVisible();
  for (const [key, v] of Object.entries(values)) {
    const input = editor.getByTestId(`loop-input-${key}`);
    if ((await input.evaluate((el) => el.tagName)) === "SELECT") await input.selectOption(v);
    else await input.fill(v);
  }
  await editor.getByTestId("loop-save").click();
  await expect(editor.getByTestId("loop-message")).toHaveText(S.lp.saved);
  for (const kind of external) {
    const box = page.getByTestId(`loop-external-${kind}`);
    await box.check();
    await expect(box).toBeChecked();
  }
}
