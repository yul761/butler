import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { FeedbackService, osName, type FeedbackServiceDeps } from "./feedback-service";
import type { DiagnosticsFile } from "../diag/diag-export";

const DIAG = {
  kind: "butler-diagnostics", schema: 1, generatedAt: "2026-11-21T00:00:00.000Z",
  app: { version: "4.0.0", versions: {}, mode: "on" },
  system: { platform: "darwin", arch: "arm64", osRelease: "25.2.0", cpus: { model: "M", count: 1 }, memory: { totalMb: 1, freeMb: 1 } },
  processes: [], mainMemory: {}, perf: { current: {}, history: [] },
  logTail: ["opened /Users/alice/Code/acme for Secret plan"],
} as unknown as DiagnosticsFile;

function setup(over: Partial<FeedbackServiceDeps> = {}) {
  const files = new Map<string, string>();
  const d: FeedbackServiceDeps = {
    env: () => ({ butler: "4.0.0", os: "macOS 15.1.0", platform: "darwin", arch: "arm64", claude: "unknown" }),
    openExternal: vi.fn(async () => undefined),
    copyText: vi.fn(),
    buildDiagnostics: async () => DIAG,
    redactTerms: () => ({ home: ["/Users/alice"], users: ["alice"], paths: [], titles: ["Secret plan"], epics: [], repos: ["acme"], branches: [], tickets: [] }),
    downloadsDir: () => "/dl",
    exists: (p) => files.has(p),
    writeFile: vi.fn(async (p: string, t: string) => void files.set(p, t)),
    showItemInFolder: vi.fn(),
    now: () => Date.parse("2026-11-21T08:09:10.123Z"),
    log: vi.fn(),
    ...over,
  };
  return { s: new FeedbackService(d), d, files };
}

describe("FeedbackService.open", () => {
  it("opens the prefilled issue page and copies nothing when it fits", async () => {
    const { s, d } = setup();
    const r = await s.open({ kind: "bug", title: "Crash", description: "boom", attachDiagnostics: false });
    expect(d.openExternal).toHaveBeenCalledWith(r.url);
    const p = new URL(r.url).searchParams;
    expect(p.get("template")).toBe("bug.yml");
    expect(p.get("environment")).toContain("Claude Code: unknown");
    expect(r.truncated).toBe(false);
    expect(d.copyText).not.toHaveBeenCalled();
  });

  it("copies the full text when the link had to be cut", async () => {
    const { s, d } = setup();
    const description = "很长的描述".repeat(300);
    const r = await s.open({ kind: "idea", title: "T", description, attachDiagnostics: false });
    expect(r.truncated).toBe(true);
    expect(d.copyText).toHaveBeenCalledWith(`T\n\n${description}`);
  });

  it("mentions the saved diagnostics file only when asked", async () => {
    const { s } = setup();
    await s.previewDiagnostics();
    const saved = await s.saveDiagnostics();
    const withFile = await s.open({ kind: "bug", title: "", description: "", attachDiagnostics: true });
    expect(new URL(withFile.url).searchParams.get("diagnostics")).toContain(saved.name);
    const without = await s.open({ kind: "bug", title: "", description: "", attachDiagnostics: false });
    expect(new URL(without.url).searchParams.has("diagnostics")).toBe(false);
  });

  it("passes a failed browser open back to the caller", async () => {
    const { s } = setup({ openExternal: async () => Promise.reject(new Error("no browser")) });
    await expect(s.open({ kind: "bug", title: "", description: "", attachDiagnostics: false })).rejects.toThrow("no browser");
  });
});

describe("FeedbackService diagnostics", () => {
  it("previews a redacted file, then saves exactly that text and shows it in the folder", async () => {
    const { s, d, files } = setup();
    const text = await s.previewDiagnostics();
    for (const leak of ["alice", "acme", "Secret", "/Users"]) expect(text).not.toContain(leak);
    expect(JSON.parse(text).redacted).toBe(true);
    const r = await s.saveDiagnostics();
    expect(r.name).toBe("butler-diagnostics-redacted-2026-11-21T08-09-10.json");
    expect(r.path).toBe(join("/dl", r.name));
    expect(files.get(r.path)).toBe(text);
    expect(d.showItemInFolder).toHaveBeenCalledWith(r.path);
  });

  it("never overwrites an existing file", async () => {
    const { s, files } = setup();
    files.set(join("/dl", "butler-diagnostics-redacted-2026-11-21T08-09-10.json"), "old");
    files.set(join("/dl", "butler-diagnostics-redacted-2026-11-21T08-09-10-1.json"), "old");
    await s.previewDiagnostics();
    expect((await s.saveDiagnostics()).name).toBe("butler-diagnostics-redacted-2026-11-21T08-09-10-2.json");
  });

  it("refuses to save without a preview, and each preview saves once", async () => {
    const { s } = setup();
    await expect(s.saveDiagnostics()).rejects.toThrow();
    await s.previewDiagnostics();
    await s.saveDiagnostics();
    await expect(s.saveDiagnostics()).rejects.toThrow();
  });

  it("a failing reveal still counts as saved", async () => {
    const { s } = setup({ showItemInFolder: () => { throw new Error("no finder"); } });
    await s.previewDiagnostics();
    await expect(s.saveDiagnostics()).resolves.toMatchObject({ name: expect.stringContaining("redacted") });
  });
});

describe("osName", () => {
  it("names the system", () => {
    expect(osName("darwin", "15.1.0")).toBe("macOS 15.1.0");
    expect(osName("win32", "10.0.22631")).toBe("Windows 10.0.22631");
    expect(osName("freebsd", null)).toBe("freebsd");
  });
});
