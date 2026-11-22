import { describe, expect, it } from "vitest";
import { BUTLER_REPO, releasesLatestUrl, isButlerReleaseUrl } from "./butler-repo";
import { compareVersions, isNewerRelease, parseVersion } from "./update";

describe("parseVersion", () => {
  it("reads X.Y.Z with an optional v, pre-release and build metadata", () => {
    expect(parseVersion("4.0.0")).toEqual({ major: 4, minor: 0, patch: 0, pre: [] });
    expect(parseVersion("v4.1.2")).toEqual({ major: 4, minor: 1, patch: 2, pre: [] });
    expect(parseVersion(" V10.20.30-rc.1+sha.abc ")).toEqual({ major: 10, minor: 20, patch: 30, pre: ["rc", "1"] });
  });

  it("rejects anything that is not a version", () => {
    for (const v of ["", "4", "4.0", "4.0.0.0", "latest", "4.x.0", "04.0.0", "4.0.0-", "4.0.0-a..b", "-1.0.0"]) expect(parseVersion(v), v).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major, minor, patch numerically", () => {
    expect(compareVersions("4.0.10", "4.0.9")).toBeGreaterThan(0);
    expect(compareVersions("4.10.0", "4.9.9")).toBeGreaterThan(0);
    expect(compareVersions("5.0.0", "4.99.99")).toBeGreaterThan(0);
    expect(compareVersions("v4.0.0", "4.0.0")).toBe(0);
  });

  it("follows SemVer precedence for pre-releases and ignores build metadata", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 1; i < ordered.length; i++) expect(compareVersions(ordered[i]!, ordered[i - 1]!), `${ordered[i]} > ${ordered[i - 1]}`).toBeGreaterThan(0);
    expect(compareVersions("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
  });

  it("returns null when either side does not parse", () => {
    expect(compareVersions("4.0.0", "nope")).toBeNull();
    expect(compareVersions("nope", "4.0.0")).toBeNull();
  });
});

describe("isNewerRelease", () => {
  const rel = (tag: string, extra: Partial<{ draft: boolean; prerelease: boolean }> = {}) => ({ tag, draft: false, prerelease: false, ...extra });

  it("is true only for a published, stable release above the current version", () => {
    expect(isNewerRelease(rel("v4.1.0"), "4.0.0")).toBe(true);
    expect(isNewerRelease(rel("v4.0.0"), "4.0.0")).toBe(false);
    expect(isNewerRelease(rel("v3.9.0"), "4.0.0")).toBe(false);
  });

  it("never counts drafts, pre-releases or a tag with a pre-release suffix", () => {
    expect(isNewerRelease(rel("v4.1.0", { draft: true }), "4.0.0")).toBe(false);
    expect(isNewerRelease(rel("v4.1.0", { prerelease: true }), "4.0.0")).toBe(false);
    expect(isNewerRelease(rel("v4.1.0-rc.1"), "4.0.0")).toBe(false);
  });

  it("offers the stable release to someone running its pre-release", () => {
    expect(isNewerRelease(rel("v4.1.0"), "4.1.0-rc.2")).toBe(true);
    expect(isNewerRelease(rel("v4.0.9"), "4.1.0-rc.2")).toBe(false);
  });

  it("is false when a version does not parse", () => {
    expect(isNewerRelease(rel("nightly"), "4.0.0")).toBe(false);
    expect(isNewerRelease(rel("v4.1.0"), "dev")).toBe(false);
  });
});

describe("butler repo", () => {
  it("builds links from the one constant", () => {
    expect(BUTLER_REPO).toBe("yul761/butler");
    expect(releasesLatestUrl()).toBe("https://github.com/yul761/butler/releases/latest");
  });

  it("accepts only release pages of the Butler repo", () => {
    expect(isButlerReleaseUrl("https://github.com/yul761/butler/releases/tag/v4.1.0")).toBe(true);
    expect(isButlerReleaseUrl("https://github.com/YUL761/Butler/releases/tag/v4.1.0")).toBe(true);
    expect(isButlerReleaseUrl("https://github.com/yul761/butler-evil/releases/tag/v4.1.0")).toBe(false);
    expect(isButlerReleaseUrl("https://github.com/other/butler/releases/tag/v4.1.0")).toBe(false);
    expect(isButlerReleaseUrl("http://github.com/yul761/butler/releases/tag/v4.1.0")).toBe(false);
    expect(isButlerReleaseUrl("https://github.com.evil/yul761/butler/releases/x")).toBe(false);
    expect(isButlerReleaseUrl("https://user@github.com/yul761/butler/releases/x")).toBe(false);
    expect(isButlerReleaseUrl("not a url")).toBe(false);
  });
});
