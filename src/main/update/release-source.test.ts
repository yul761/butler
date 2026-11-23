import { describe, expect, it } from "vitest";
import { classifyGhFailure, latestRelease, parseRelease, RELEASE_API_PATH, type GhRun } from "./release-source";
import { RELEASE_NOTES_LIMIT } from "../../shared/update";

const release = {
  tag_name: "v4.1.0", html_url: "https://github.com/yul761/shipherd/releases/tag/v4.1.0", draft: false, prerelease: false,
  published_at: "2026-11-21T05:44:00Z", body: "## What's new\n- update notice",
};

function fake(r: Awaited<ReturnType<GhRun>>): { run: GhRun; calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] } {
  const calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  return { calls, run: async (args, env) => (calls.push({ args, env }), r) };
}

describe("latestRelease", () => {
  it("asks gh api for the Shipherd repo's latest release, pinned to github.com", async () => {
    const f = fake({ stdout: JSON.stringify(release), stderr: "", spawnError: null, timedOut: false });
    const r = await latestRelease(f.run);
    expect(f.calls).toEqual([{ args: ["api", "repos/yul761/shipherd/releases/latest"], env: { GH_HOST: "github.com" } }]);
    expect(RELEASE_API_PATH).toBe("repos/yul761/shipherd/releases/latest");
    expect(r).toEqual({
      ok: true,
      release: { version: "4.1.0", tag: "v4.1.0", url: release.html_url, publishedAt: Date.parse(release.published_at), notes: release.body },
      draft: false, prerelease: false,
    });
  });

  it("reports why it could not check", async () => {
    const cases: [Awaited<ReturnType<GhRun>>, string][] = [
      [{ stdout: null, stderr: "", spawnError: "ENOENT", timedOut: false }, "no_gh"],
      [{ stdout: null, stderr: "", spawnError: null, timedOut: true }, "offline"],
      [{ stdout: "not json", stderr: "", spawnError: null, timedOut: false }, "bad_response"],
      [{ stdout: JSON.stringify({ message: "hi" }), stderr: "", spawnError: null, timedOut: false }, "bad_response"],
      [{ stdout: null, stderr: "gh: Not Found (HTTP 404)", spawnError: null, timedOut: false }, "no_release"],
    ];
    for (const [res, reason] of cases) {
      const r = await latestRelease(fake(res).run);
      expect(r.ok ? null : r.reason, JSON.stringify(res)).toBe(reason);
    }
  });

  it("never throws, even when running gh does", async () => {
    const r = await latestRelease(async () => { throw new Error("boom"); });
    expect(r).toEqual({ ok: false, reason: "failed", detail: "boom" });
  });
});

describe("classifyGhFailure", () => {
  it("tells not logged in, rate limits and network failures apart", () => {
    expect(classifyGhFailure("To get started with GitHub CLI, please run:  gh auth login")).toBe("not_logged_in");
    expect(classifyGhFailure("gh: Bad credentials (HTTP 401)")).toBe("not_logged_in");
    expect(classifyGhFailure("HTTP 401: Requires authentication")).toBe("not_logged_in");
    expect(classifyGhFailure("gh: API rate limit exceeded for user ID 1. (HTTP 403)")).toBe("rate_limited");
    expect(classifyGhFailure("You have exceeded a secondary rate limit (HTTP 403)")).toBe("rate_limited");
    expect(classifyGhFailure("HTTP 429: Too Many Requests")).toBe("rate_limited");
    expect(classifyGhFailure('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com')).toBe("offline");
    expect(classifyGhFailure("Get \"https://api.github.com/...\": dial tcp: lookup api.github.com: no such host")).toBe("offline");
    expect(classifyGhFailure("net/http: TLS handshake timeout")).toBe("offline");
    expect(classifyGhFailure("Not Found (HTTP 404)")).toBe("no_release");
    expect(classifyGhFailure("something else entirely")).toBe("failed");
  });
});

describe("parseRelease", () => {
  it("caps the notes and tolerates a missing body or date", () => {
    const r = parseRelease({ ...release, body: "x".repeat(RELEASE_NOTES_LIMIT + 50), published_at: null });
    expect(r?.release.notes).toHaveLength(RELEASE_NOTES_LIMIT);
    expect(r?.release.publishedAt).toBeNull();
    expect(parseRelease({ ...release, body: null })?.release.notes).toBe("");
  });

  it("rejects a release without a tag or a page", () => {
    expect(parseRelease({ ...release, tag_name: "" })).toBeNull();
    expect(parseRelease({ ...release, html_url: 3 })).toBeNull();
    expect(parseRelease([])).toBeNull();
  });
});
