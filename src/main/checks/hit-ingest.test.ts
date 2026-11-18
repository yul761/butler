import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HitIngest, parseCheckLogRecord } from "./hit-ingest";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hit = {
  kind: "hit", checkId: 3, checkKey: "ck_1", slug: "a/b", file: "src/x.ts", line: 2, stage: "edit", mode: "shadow", severity: "block", outcome: "fail",
  blocked: false, detail: "d", session: "s1", at: 5,
};

describe("parseCheckLogRecord", () => {
  it("accepts hits and absent records", () => {
    expect(parseCheckLogRecord(JSON.stringify(hit))).toMatchObject({ kind: "hit", checkKey: "ck_1", line: 2 });
    expect(parseCheckLogRecord(JSON.stringify({ kind: "absent", reason: "no_snapshot", session: "s1", at: 1 }))).toMatchObject({ kind: "absent" });
  });
  it("rejects malformed lines", () => {
    expect(parseCheckLogRecord("{")).toBeNull();
    expect(parseCheckLogRecord(JSON.stringify({ ...hit, outcome: "nope" }))).toBeNull();
    expect(parseCheckLogRecord(JSON.stringify({ ...hit, line: -1 }))).toBeNull();
    expect(parseCheckLogRecord(JSON.stringify({ kind: "absent", reason: "x", session: null, at: 1 }))).toBeNull();
  });
});

describe("HitIngest", () => {
  it("ingests each file once, records absences and deletes the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butler-hits-"));
    dirs.push(dir);
    writeFileSync(join(dir, "1-1-a.jsonl"), [JSON.stringify(hit), "garbage", JSON.stringify({ kind: "absent", reason: "snapshot_version", session: "s1", at: 1 })].join("\n"));
    writeFileSync(join(dir, "ignored.tmp"), "x");
    const rows: { key: string }[] = [];
    const absent: string[] = [];
    let notified = 0;
    const ing = new HitIngest({
      dir, insertHits: (r) => (rows.push(...r), r.length), markAbsent: (s, reason) => absent.push(`${s}:${reason}`), onIngested: (n) => (notified += n),
    });
    expect(await ing.drain()).toBe(1);
    expect(rows.map((r) => r.key)).toEqual(["1-1-a.jsonl:0"]);
    expect(absent).toEqual(["s1:snapshot_version"]);
    expect(notified).toBe(1);
    expect(readdirSync(dir)).toEqual(["ignored.tmp"]);
  });

  it("keeps the file when the database write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butler-hits-"));
    dirs.push(dir);
    writeFileSync(join(dir, "2.jsonl"), JSON.stringify(hit));
    const ing = new HitIngest({ dir, insertHits: () => { throw new Error("busy"); }, markAbsent: () => {} });
    expect(await ing.drain()).toBe(0);
    expect(readdirSync(dir)).toEqual(["2.jsonl"]);
  });
});
