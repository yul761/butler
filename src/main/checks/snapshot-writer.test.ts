import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSnapshotState, SnapshotWriter } from "./snapshot-writer";
import { CHECKS_SNAPSHOT_VERSION, type CheckSnapshot } from "../../shared/checks";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "butler-snap-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const snap = (at: number, enabled = true): CheckSnapshot => ({
  v: CHECKS_SNAPSHOT_VERSION, generatedAt: at, enabled, editTimeoutMs: 8000, pushTimeoutMs: 600000, ticketPattern: "X-\\d+",
  strings: { failHeader: "f", shadowTag: "s", warnTag: "w", blockFooter: "b", pushHeader: "p" }, global: [], repos: {},
});

describe("SnapshotWriter", () => {
  it("writes atomically and skips identical content", () => {
    const file = join(tmp(), "checks", "snapshot.json");
    let at = 1;
    let enabled = true;
    const w = new SnapshotWriter({ file, build: () => snap(at++, enabled) });
    expect(w.writeNow()).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).generatedAt).toBe(1);
    expect(w.writeNow()).toBe(false);
    enabled = false;
    expect(w.writeNow()).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
    expect(w.lastStatus().error).toBeNull();
  });

  it("keeps an identical file from a previous run", () => {
    const file = join(tmp(), "snapshot.json");
    writeFileSync(file, JSON.stringify(snap(5)));
    const w = new SnapshotWriter({ file, build: () => snap(9) });
    expect(w.writeNow()).toBe(false);
    expect(w.lastStatus().writtenAt).toBe(5);
  });

  it("records a failed write instead of throwing", () => {
    const dir = tmp();
    writeFileSync(join(dir, "blocker"), "x");
    const w = new SnapshotWriter({ file: join(dir, "blocker", "snapshot.json"), build: () => snap(1) });
    expect(w.writeNow()).toBe(false);
    expect(w.lastStatus().error).toBeTruthy();
  });

  it("reads the state of a snapshot file", () => {
    const d = tmp();
    expect(readSnapshotState(join(d, "none.json"), 1)).toBe("missing");
    writeFileSync(join(d, "bad.json"), "{");
    expect(readSnapshotState(join(d, "bad.json"), 1)).toBe("unreadable");
    writeFileSync(join(d, "v.json"), JSON.stringify({ v: 99 }));
    expect(readSnapshotState(join(d, "v.json"), 1)).toBe("version");
    writeFileSync(join(d, "ok.json"), JSON.stringify(snap(1)));
    expect(readSnapshotState(join(d, "ok.json"), CHECKS_SNAPSHOT_VERSION)).toBe("ok");
  });
});
