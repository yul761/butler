import { describe, expect, it, vi } from "vitest";
import { EXTERNAL_LINK_MAX, openExternalLink, safeExternalUrl } from "./external-link";

describe("safeExternalUrl", () => {
  it("lets http and https through, normalised by the URL parser", () => {
    expect(safeExternalUrl("https://github.com/yul761/butler/pull/1")).toBe("https://github.com/yul761/butler/pull/1");
    expect(safeExternalUrl("http://localhost:5173/x?y=1#z")).toBe("http://localhost:5173/x?y=1#z");
    expect(safeExternalUrl("HTTPS://Example.COM")).toBe("https://example.com/");
  });

  it("refuses every other scheme and anything that is not a URL", () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vscode://file/x",
      "ssh://host",
      "ftp://host/x",
      "mailto:a@b.c",
      "smb://host/share",
      "chrome://settings",
      "about:blank",
      "//evil.example/x",
      "github.com/a/b",
      "https://github.com@evil.example/login",
      "https://github.com:token@evil.example/",
      "http://user:@example.com/",
      "not a url",
      "",
    ]) {
      expect(safeExternalUrl(bad), bad).toBeNull();
    }
  });

  it("refuses an over-long link instead of truncating it", () => {
    const base = "https://example.com/";
    expect(safeExternalUrl(base + "a".repeat(EXTERNAL_LINK_MAX - base.length))).not.toBeNull();
    expect(safeExternalUrl(base + "a".repeat(EXTERNAL_LINK_MAX - base.length + 1))).toBeNull();
  });
});

describe("openExternalLink", () => {
  it("hands the parsed href to openExternal", () => {
    const openExternal = vi.fn(async () => {});
    const log = vi.fn();
    expect(openExternalLink("https://Example.com/a b", { openExternal, log })).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/a%20b");
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses a non-http link, logs it and never calls openExternal", () => {
    const openExternal = vi.fn(async () => {});
    const log = vi.fn();
    expect(openExternalLink("file:///etc/passwd", { openExternal, log })).toEqual({ ok: false, reason: "bad_url" });
    expect(openExternal).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("refused to open link (only http/https without credentials): file:");
  });

  it("never writes credentials, paths or query strings of a refused link to the log", () => {
    const log = vi.fn();
    expect(openExternalLink("https://github.com:s3cret@evil.example/login?token=t0k", { openExternal: vi.fn(), log })).toEqual({ ok: false, reason: "bad_url" });
    expect(openExternalLink("vscode://file/Users/me/s3cret.txt", { openExternal: vi.fn(), log })).toEqual({ ok: false, reason: "bad_url" });
    expect(openExternalLink("not a url s3cret", { openExternal: vi.fn(), log })).toEqual({ ok: false, reason: "bad_url" });
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      "refused to open link (only http/https without credentials): https://evil.example",
      "refused to open link (only http/https without credentials): vscode://file",
      "refused to open link (only http/https without credentials): unparseable (16 chars)",
    ]);
  });

  it("logs when the browser cannot be opened", async () => {
    const err = new Error("no browser");
    const log = vi.fn();
    expect(openExternalLink("https://example.com/?token=secret", { openExternal: () => Promise.reject(err), log })).toEqual({ ok: true });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("opening a link on https://example.com failed", err));
    const thrown = vi.fn();
    openExternalLink("https://example.com/?token=secret", { openExternal: () => { throw err; }, log: thrown });
    expect(thrown).toHaveBeenCalledWith("opening a link on https://example.com failed", err);
    // 查询串里的 token 不进日志。
    expect(JSON.stringify([...log.mock.calls, ...thrown.mock.calls])).not.toContain("secret");
  });
});
