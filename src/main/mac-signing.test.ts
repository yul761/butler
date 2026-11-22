import { describe, expect, it, vi } from "vitest";
import { signMacApp } from "../../scripts/after-pack.cjs";
import { macSigningMode, releaseSigningMode, SIGNING_SECRETS } from "../../scripts/mac-signing.cjs";
import { gatekeeperVerdict, isMachOHeader, parseCodesignDisplay, signatureProblems } from "../../scripts/verify-mac-signing.mjs";

// BTL-258：macOS 签名两条路只走一条（scripts/mac-signing.cjs、after-pack.cjs），以及 CI 用来核对签名结果的解析（verify-mac-signing.mjs）。
type Env = Record<string, string | undefined>;

describe("which macOS signing runs (after-pack)", () => {
  it("leaves signing to electron-builder when a certificate is given, and never signs ad-hoc as well", () => {
    for (const env of [{ CSC_LINK: "base64-p12" }, { CSC_NAME: "Developer ID Application: X (TEAM)" }, { CSC_LINK: "x", CSC_IDENTITY_AUTO_DISCOVERY: "true" }]) {
      const exec = vi.fn();
      const e: Env = { ...env };
      expect(signMacApp({ appPath: "/tmp/Butler.app", env: e, exec }), JSON.stringify(env)).toBe("builder");
      expect(exec).not.toHaveBeenCalled();
      // 不能关掉 electron-builder 的证书发现：否则 CSC_LINK 导入的证书会被悄悄跳过。
      expect(e.CSC_IDENTITY_AUTO_DISCOVERY).toBe(env.CSC_IDENTITY_AUTO_DISCOVERY);
    }
  });

  it("treats an explicit mac.identity (even '-') as electron-builder's signing", () => {
    const exec = vi.fn();
    expect(signMacApp({ appPath: "/a.app", env: {}, identity: "-", exec })).toBe("builder");
    expect(exec).not.toHaveBeenCalled();
  });

  it("signs ad-hoc without a certificate and stops electron-builder from finding one in the keychain afterwards", () => {
    for (const env of [{}, { CSC_LINK: "" }, { CSC_LINK: "   ", CSC_NAME: "" }]) {
      const exec = vi.fn();
      const e: Env = { ...env };
      expect(signMacApp({ appPath: "/tmp/Butler.app", env: e, identity: undefined, exec })).toBe("ad-hoc");
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith("codesign", ["--force", "--deep", "--sign", "-", "/tmp/Butler.app"], { stdio: "inherit" });
      // 本机钥匙串里有 Developer ID 时，electron-builder 默认会自动找到它再签一遍：ad-hoc 之后必须关掉。
      expect(e.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    }
  });

  it("signs ad-hoc when the config sets identity to null", () => {
    expect(macSigningMode({ env: { CSC_LINK: "" }, identity: null }).mode).toBe("ad-hoc");
  });

  it("refuses a certificate that electron-builder would silently skip", () => {
    const exec = vi.fn();
    expect(() => signMacApp({ appPath: "/a.app", env: { CSC_LINK: "x", CSC_IDENTITY_AUTO_DISCOVERY: "false" }, exec })).toThrow(/would skip signing/);
    expect(exec).not.toHaveBeenCalled();
    // 按名字找证书不依赖自动发现，可以。
    expect(macSigningMode({ env: { CSC_LINK: "x", CSC_NAME: "Y", CSC_IDENTITY_AUTO_DISCOVERY: "false" } })).toEqual({ mode: "builder" });
  });
});

describe("release.yml signing decision ([contract:mac-signing])", () => {
  const all = Object.fromEntries(SIGNING_SECRETS.map((n) => [n, true]));
  const none = Object.fromEntries(SIGNING_SECRETS.map((n) => [n, false]));

  it("uses the five agreed secret names", () => {
    expect(SIGNING_SECRETS).toEqual(["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY_P8", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]);
  });

  it("signs with Developer ID when all five are set, ad-hoc when none is", () => {
    expect(releaseSigningMode({ present: all, requireSigning: false })).toEqual({ mode: "developer-id" });
    expect(releaseSigningMode({ present: all, requireSigning: true })).toEqual({ mode: "developer-id" });
    expect(releaseSigningMode({ present: none, requireSigning: false })).toEqual({ mode: "ad-hoc" });
    expect(releaseSigningMode({ present: {}, requireSigning: false })).toEqual({ mode: "ad-hoc" });
  });

  it("fails, naming the missing ones, when only some are set (never a half-signed or unnotarized build)", () => {
    for (const missing of SIGNING_SECRETS) {
      const r = releaseSigningMode({ present: { ...all, [missing]: false }, requireSigning: false });
      expect("error" in r && r.error, missing).toContain(missing);
      expect("error" in r && r.error).not.toMatch(new RegExp(SIGNING_SECRETS.filter((n) => n !== missing).map((n) => `\\b${n}\\b,`).join("|") || "$^"));
    }
  });

  it("fails a manual signing trial instead of falling back to ad-hoc when no secret is set", () => {
    const r = releaseSigningMode({ present: none, requireSigning: true });
    expect("error" in r && r.error).toMatch(/requires a signed build/);
  });
});

const DEVELOPER_ID = `Executable=/x/Butler.app/Contents/MacOS/Butler
Identifier=io.statecore.butler
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=765 flags=0x10000(runtime) hashes=13+7 location=embedded
Signature size=8991
Authority=Developer ID Application: Yuchen Lin (K4DJPVL5T5)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 22, 2026 at 10:24:42 AM
Notarization Ticket=stapled
TeamIdentifier=K4DJPVL5T5
`;
const ADHOC = `Executable=/x/Butler.app/Contents/MacOS/Butler
Identifier=Butler
CodeDirectory v=20400 size=436 flags=0x2(adhoc) hashes=3+7 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
`;

describe("reading codesign and spctl output (verify-mac-signing)", () => {
  it("parses a Developer ID signature with the hardened runtime and a secure timestamp", () => {
    expect(parseCodesignDisplay(DEVELOPER_ID)).toEqual({
      signed: true,
      adhoc: false,
      authority: "Developer ID Application: Yuchen Lin (K4DJPVL5T5)",
      teamId: "K4DJPVL5T5",
      runtime: true,
      timestamp: true,
    });
    expect(signatureProblems("f", parseCodesignDisplay(DEVELOPER_ID), "developer-id", "K4DJPVL5T5")).toEqual([]);
  });

  it("parses an ad-hoc signature and an unsigned file", () => {
    expect(parseCodesignDisplay(ADHOC)).toMatchObject({ signed: true, adhoc: true, teamId: undefined, runtime: false, timestamp: false });
    expect(parseCodesignDisplay("/x/spawn-helper: code object is not signed at all\n").signed).toBe(false);
    // codesign 跑不起来、超时：输出为空，不能当作签过了。
    expect(parseCodesignDisplay("").signed).toBe(false);
  });

  it("accepts an ad-hoc signature in an ad-hoc build but never an unsigned file", () => {
    expect(signatureProblems("f", parseCodesignDisplay(ADHOC), "ad-hoc", undefined)).toEqual([]);
    expect(signatureProblems("f", parseCodesignDisplay(""), "ad-hoc", undefined)).toEqual(["f: not signed"]);
  });

  it("names every way a file falls short of a notarizable Developer ID signature", () => {
    expect(signatureProblems("f", parseCodesignDisplay(ADHOC), "developer-id", "K4DJPVL5T5").join("\n")).toMatch(
      /Developer ID Application[\s\S]*Team ID[\s\S]*hardened runtime[\s\S]*timestamp/,
    );
    const otherTeam = DEVELOPER_ID.replace(/K4DJPVL5T5/g, "OTHERTEAM1");
    expect(signatureProblems("f", parseCodesignDisplay(otherTeam), "developer-id", "K4DJPVL5T5")).toEqual(["f: Team ID OTHERTEAM1 differs from the app's K4DJPVL5T5"]);
    const noRuntime = DEVELOPER_ID.replace("flags=0x10000(runtime)", "flags=0x0(none)").replace(/^Timestamp=.*$/m, "Signed Time=Nov 22, 2026");
    expect(signatureProblems("f", parseCodesignDisplay(noRuntime), "developer-id", "K4DJPVL5T5")).toEqual(["f: hardened runtime is off", "f: no secure timestamp"]);
  });

  it("reads Gatekeeper's verdict, including a runner with assessments disabled", () => {
    expect(gatekeeperVerdict(0, "/x/Butler.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Yuchen Lin (K4DJPVL5T5)\n")).toBe("notarized");
    // 签了名但没公证：spctl 拒绝（source=Unnotarized Developer ID）。
    expect(gatekeeperVerdict(3, "/x/Butler.app: rejected\nsource=Unnotarized Developer ID\n")).toBe("rejected");
    expect(gatekeeperVerdict(0, "/x/Butler.app: accepted\nsource=Developer ID\n")).toBe("rejected");
    expect(gatekeeperVerdict(0, "/x/Butler.app: accepted\noverride=security disabled\n")).toBe("disabled");
    expect(gatekeeperVerdict(null, "")).toBe("rejected");
  });

  it("recognises Mach-O files (thin and universal) and nothing else", () => {
    for (const magic of [0xcffaedfe, 0xcefaedfe, 0xcafebabe]) {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(magic);
      expect(isMachOHeader(b), magic.toString(16)).toBe(true);
    }
    expect(isMachOHeader(Buffer.from("MZ\x90\x00", "latin1"))).toBe(false); // Windows PE
    expect(isMachOHeader(Buffer.from("#!/b", "latin1"))).toBe(false);
    expect(isMachOHeader(Buffer.alloc(2))).toBe(false);
  });
});
