// 检查 macOS 包的签名，并用打出来的包跑一遍冒烟（BTL-258）。CI 在 pnpm dist 和 verify-package 之后运行。
// 用法：node scripts/verify-mac-signing.mjs [dist 目录] --mode ad-hoc|developer-id
//
// 两种模式都查：
// - app 的签名完整（codesign --verify --deep --strict），app 里每个 Mach-O（Electron 的 helper 和 framework、node-pty 的
//   pty.node 和 spawn-helper、butler-hook）都签了名；
// - zip 解开、dmg 挂上以后，里面的 app 签名仍然完整（打包没有弄坏签名，下载的人才打得开）；
// - 冒烟：包里的 Butler --smoke（sqlite、StateCore、node-pty 经 spawn-helper 跑命令），ELECTRON_RUN_AS_NODE 的 Butler，butler-hook。
//   developer-id 时它们都在 hardened runtime 下运行，entitlements 不够或库验证不过会在这里失败，而不是在用户机器上。
// developer-id 另外查：每个 Mach-O 都是同一个 Team ID 的 Developer ID Application 签名、打开了 hardened runtime、带安全时间戳；
// app 和 dmg 都 staple 了公证票据；Gatekeeper（spctl）认它们是 Notarized Developer ID。
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

/** 文件开头 4 个字节是不是 Mach-O（单架构或 fat）。 */
export function isMachOHeader(buf) {
  return buf.length >= 4 && MACHO_MAGICS.has(buf.readUInt32BE(0));
}

/**
 * 解析 codesign -dv --verbose=4 的输出（它写在 stderr）。
 * @returns {{ signed: boolean, adhoc: boolean, authority?: string, teamId?: string, runtime: boolean, timestamp: boolean }}
 */
export function parseCodesignDisplay(text) {
  if (/code object is not signed at all/.test(text)) return { signed: false, adhoc: false, runtime: false, timestamp: false };
  const authority = /^Authority=(.+)$/m.exec(text)?.[1];
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1];
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text)?.[1] ?? "";
  return {
    signed: /^(Identifier|CodeDirectory)/m.test(text),
    adhoc: /^Signature=adhoc$/m.test(text) || flags.split(",").includes("adhoc"),
    authority,
    teamId: team && team !== "not set" ? team : undefined,
    runtime: flags.split(",").includes("runtime"),
    // 安全时间戳（Apple 的时间戳服务器）是 Timestamp=；没有时间戳服务器时只有 Signed Time=，公证会拒。
    timestamp: /^Timestamp=/m.test(text),
  };
}

/**
 * 一个 Mach-O 的签名在这个模式下有什么问题。
 * @param {ReturnType<typeof parseCodesignDisplay>} sig
 * @param {"ad-hoc" | "developer-id"} mode
 * @param {string | undefined} teamId developer-id 时 app 主程序的 Team ID，所有文件都要一致
 */
export function signatureProblems(file, sig, mode, teamId) {
  if (!sig.signed) return [`${file}: not signed`];
  if (mode === "ad-hoc") return [];
  const problems = [];
  if (sig.adhoc || !sig.authority?.startsWith("Developer ID Application:")) problems.push(`${file}: not signed with a Developer ID Application certificate (${sig.authority ?? "ad-hoc"})`);
  if (!sig.teamId || sig.teamId !== teamId) problems.push(`${file}: Team ID ${sig.teamId ?? "not set"} differs from the app's ${teamId ?? "not set"}`);
  if (!sig.runtime) problems.push(`${file}: hardened runtime is off`);
  if (!sig.timestamp) problems.push(`${file}: no secure timestamp`);
  return problems;
}

/**
 * spctl --assess 的输出是否说明 Gatekeeper 认它是公证过的 Developer ID。
 * @returns {"notarized" | "disabled" | "rejected"} disabled：这台机器关了 Gatekeeper 评估（spctl 什么都放行），只能靠 stapler 的结果
 */
export function gatekeeperVerdict(status, output) {
  if (/override=security disabled/.test(output)) return "disabled";
  if (status === 0 && /source=Notarized Developer ID/.test(output)) return "notarized";
  return "rejected";
}

function machOFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) machOFiles(p, out);
    else if (st.isFile() && st.size >= 4) {
      const fd = openSync(p, "r");
      const buf = Buffer.alloc(4);
      readSync(fd, buf, 0, 4, 0);
      closeSync(fd);
      if (isMachOHeader(buf)) out.push(p);
    }
  }
  return out;
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, ...opts });
const both = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

function checkApp(app, mode, label, problems) {
  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  if (verify.status !== 0) problems.push(`${label}: codesign --verify --deep --strict failed:\n${both(verify).trim()}`);
  const files = machOFiles(app);
  const main = join(app, "Contents", "MacOS", "Butler");
  const mainSig = parseCodesignDisplay(both(run("codesign", ["-dv", "--verbose=4", main])));
  for (const f of files) {
    const sig = parseCodesignDisplay(both(run("codesign", ["-dv", "--verbose=4", f])));
    problems.push(...signatureProblems(`${label}: ${f.slice(app.length + 1)}`, sig, mode, mainSig.teamId));
  }
  if (mode === "developer-id") {
    const staple = run("xcrun", ["stapler", "validate", app]);
    if (staple.status !== 0) problems.push(`${label}: no valid stapled notarization ticket:\n${both(staple).trim()}`);
    const gk = run("spctl", ["--assess", "--type", "execute", "-vv", app]);
    const verdict = gatekeeperVerdict(gk.status, both(gk));
    if (verdict === "rejected") problems.push(`${label}: Gatekeeper rejects it:\n${both(gk).trim()}`);
    if (verdict === "disabled") console.log(`  ${label}: Gatekeeper assessment is disabled on this machine; relying on the stapled ticket`);
  }
  return files.length;
}

/**
 * 用打出来的包跑三件事：
 * 1. Butler --smoke（src/main/smoke.ts）：Electron 主进程加载 node:sqlite、StateCore，用 node-pty 经 spawn-helper 跑 echo；
 * 2. ELECTRON_RUN_AS_NODE=1 的 Butler（记忆 MCP 就这样跑）执行一段 JavaScript 并用 node:sqlite；
 * 3. butler-hook readonly：空输入一定回答 deny，不写任何文件。
 * HOME 指向临时目录，不碰这台机器上的 ~/.butler。
 */
function smoke(app, home, problems) {
  const exe = join(app, "Contents", "MacOS", "Butler");
  const env = { ...process.env, HOME: home };
  const main = run(exe, ["--smoke"], { env, timeout: 90_000 });
  if (main.status !== 0 || !/pty-ok/.test(main.stdout ?? "")) problems.push(`smoke: Butler --smoke failed (exit ${main.status}, signal ${main.signal}):\n${both(main).trim()}`);
  const script = 'const { DatabaseSync } = require("node:sqlite"); const n = new DatabaseSync(":memory:").prepare("SELECT 41 + 1 AS n").get().n; let s = 0; for (let i = 0; i < 1e6; i++) s += i; process.stdout.write(`node-ok ${n}`);';
  const node = run(exe, ["-e", script], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 });
  if (node.status !== 0 || !/node-ok 42/.test(node.stdout ?? "")) problems.push(`smoke: ELECTRON_RUN_AS_NODE Butler failed (exit ${node.status}, signal ${node.signal}):\n${both(node).trim()}`);
  const hook = run(join(app, "Contents", "Resources", "hook", "butler-hook"), ["readonly"], { env, input: "", timeout: 60_000 });
  if (hook.status !== 0 || !/"permissionDecision":"deny"/.test(hook.stdout ?? "")) {
    problems.push(`smoke: butler-hook failed (exit ${hook.status}, signal ${hook.signal}):\n${both(hook).trim()}`);
  }
}

export function verifyMacSigning(distDir, mode) {
  const problems = [];
  const dist = resolve(distDir);
  const macDir = readdirSync(dist).find((d) => d.startsWith("mac") && existsSync(join(dist, d, "Butler.app")));
  if (!macDir) return [`no mac*/Butler.app under ${dist}`];
  const app = join(dist, macDir, "Butler.app");
  const count = checkApp(app, mode, "app", problems);
  console.log(`  app: checked ${count} Mach-O files`);

  const scratch = mkdtempSync(join(tmpdir(), "butler-verify-sign-"));
  try {
    const home = join(scratch, "home");
    mkdirSync(home);
    smoke(app, home, problems);
    for (const zip of readdirSync(dist).filter((f) => f.endsWith(".zip"))) {
      const out = join(scratch, zip);
      execFileSync("ditto", ["-x", "-k", join(dist, zip), out]);
      checkApp(join(out, "Butler.app"), mode, zip, problems);
    }
    for (const dmg of readdirSync(dist).filter((f) => f.endsWith(".dmg"))) {
      const file = join(dist, dmg);
      const mount = join(scratch, `${dmg}.mount`);
      execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, file], { stdio: "ignore" });
      try {
        checkApp(join(mount, "Butler.app"), mode, dmg, problems);
      } finally {
        execFileSync("hdiutil", ["detach", mount, "-force"], { stdio: "ignore" });
      }
      if (mode === "developer-id") {
        const sig = parseCodesignDisplay(both(run("codesign", ["-dv", "--verbose=4", file])));
        if (!sig.signed || !sig.authority?.startsWith("Developer ID Application:")) problems.push(`${dmg}: not signed with Developer ID`);
        const staple = run("xcrun", ["stapler", "validate", file]);
        if (staple.status !== 0) problems.push(`${dmg}: no valid stapled notarization ticket:\n${both(staple).trim()}`);
        const gk = run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", file]);
        if (gatekeeperVerdict(gk.status, both(gk)) === "rejected") problems.push(`${dmg}: Gatekeeper rejects it:\n${both(gk).trim()}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--mode");
  const mode = i >= 0 ? args[i + 1] : undefined;
  const dist = args.find((a, j) => !a.startsWith("--") && j !== i + 1) ?? "dist";
  if (process.platform !== "darwin") {
    console.error("verify-mac-signing only runs on macOS");
    process.exit(1);
  }
  if (mode !== "ad-hoc" && mode !== "developer-id") {
    console.error("usage: node scripts/verify-mac-signing.mjs [dist] --mode ad-hoc|developer-id");
    process.exit(1);
  }
  const problems = verifyMacSigning(dist, mode);
  if (problems.length > 0) {
    console.error(`macOS signing check (${mode}) found ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`macOS signing ok (${mode}, ${dist})`);
}
