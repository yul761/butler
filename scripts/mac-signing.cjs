// macOS 签名走哪条路（BTL-258）。after-pack.cjs 和测试都用这里的判断，两种签名只能走一种：
// - "builder"：electron-builder 自己签名（hardened runtime + entitlements，有 APPLE_API_* 时再公证）。release.yml 有签名
//   secret 时就是这条路，用 Developer ID Application 证书。条件和 electron-builder 找证书的条件一致：配置里写了 identity
//   （本地可以用 -c.mac.identity=- 试 hardened runtime 下的 ad-hoc 包），或者有 CSC_NAME（按名字找证书），或者有 CSC_LINK
//   （证书导入临时钥匙串后自动发现；这时 CSC_IDENTITY_AUTO_DISCOVERY 不能是 false，否则 electron-builder 会悄悄跳过签名）。
// - "ad-hoc"：没有证书（fork、PR、本地打包）。after-pack 用 codesign --sign - 签整个 app，并把 CSC_IDENTITY_AUTO_DISCOVERY
//   设成 false，electron-builder 就不会再从钥匙串里找一个证书把它签第二遍。
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

/**
 * @param {{ env: Record<string, string | undefined>, identity?: unknown }} input identity 是 electron-builder 配置里的 mac.identity
 * @returns {{ mode: "builder" | "ad-hoc", problem?: string }} problem 非空表示这样打包会出错，调用方应当中止
 */
function macSigningMode({ env, identity }) {
  const explicit = nonEmpty(identity) || nonEmpty(env.CSC_NAME);
  if (explicit) return { mode: "builder" };
  if (nonEmpty(env.CSC_LINK)) {
    if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
      return {
        mode: "builder",
        problem: "CSC_LINK is set but CSC_IDENTITY_AUTO_DISCOVERY is false: electron-builder would skip signing. Unset it (or set CSC_NAME) for a Developer ID build.",
      };
    }
    return { mode: "builder" };
  }
  return { mode: "ad-hoc" };
}

/** [contract:mac-signing] 的五个 GitHub Actions secret。都有才签名公证；一个都没有走 ad-hoc；只有一部分算配置错误。 */
const SIGNING_SECRETS = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY_P8", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];

/**
 * release.yml 在 macOS 上打包前决定签不签（只看 secret 有没有设，不碰内容）。
 * @param {{ present: Record<string, boolean>, requireSigning: boolean }} input requireSigning：手动触发的试签名，必须签成
 * @returns {{ mode: "developer-id" | "ad-hoc" } | { error: string }}
 */
function releaseSigningMode({ present, requireSigning }) {
  const missing = SIGNING_SECRETS.filter((n) => !present[n]);
  if (missing.length === SIGNING_SECRETS.length) {
    if (requireSigning) {
      return { error: `This run requires a signed build, but none of the macOS signing secrets is set (${SIGNING_SECRETS.join(", ")}). See docs/how-it-works.md ("Signing the macOS build of a fork"), or run it with require_signing off for an ad-hoc build.` };
    }
    return { mode: "ad-hoc" };
  }
  if (missing.length > 0) {
    return { error: `Only some macOS signing secrets are set; missing: ${missing.join(", ")}. Set all five (see "Signing the macOS build of a fork" in docs/how-it-works.md) or remove them all for an ad-hoc build.` };
  }
  return { mode: "developer-id" };
}

module.exports = { macSigningMode, releaseSigningMode, SIGNING_SECRETS };

// release.yml 的用法：node scripts/mac-signing.cjs release。HAS_<名字>=true/false 由 workflow 用 secrets.X != '' 算好传进来，
// 这里拿不到也不需要 secret 的内容。结果写进 GITHUB_OUTPUT（mode=...）和这次运行的摘要。
if (process.argv[1] && require("node:path").resolve(process.argv[1]) === module.filename && process.argv[2] === "release") {
  const { appendFileSync } = require("node:fs");
  const present = Object.fromEntries(SIGNING_SECRETS.map((n) => [n, process.env[`HAS_${n}`] === "true"]));
  const result = releaseSigningMode({ present, requireSigning: process.env.REQUIRE_SIGNING === "true" });
  if ("error" in result) {
    console.log(`::error::${result.error}`);
    process.exit(1);
  }
  const line = result.mode === "developer-id" ? "macOS: signed with Developer ID, notarized and stapled" : "macOS: ad-hoc signed (no signing secrets); Gatekeeper will block it until the user allows it";
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}
