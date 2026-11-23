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
  it("accepts hits, absent and present records", () => {
    expect(parseCheckLogRecord(JSON.stringify({ kind: "present", session: "s1", at: 3 }))).toEqual({ kind: "present", session: "s1", at: 3 });
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
    const dir = mkdtempSync(join(tmpdir(), "shipherd-hits-"));
    dirs.push(dir);
    writeFileSync(join(dir, "1-1-a.jsonl"), [JSON.stringify(hit), "garbage", JSON.stringify({ kind: "absent", reason: "snapshot_version", session: "s1", at: 1 }), JSON.stringify({ kind: "present", session: "s1", at: 2 })].join("\n"));
    writeFileSync(join(dir, "ignored.tmp"), "x");
    const rows: { key: string }[] = [];
    const absent: string[] = [];
    let notified = 0;
    const ing = new HitIngest({
      dir, insertHits: (r) => (rows.push(...r), r.length), markAbsent: (s, reason) => absent.push(`${s}:${reason}`), onIngested: (n) => (notified += n),
    });
    expect(await ing.drain()).toBe(1);
    expect(rows.map((r) => r.key)).toEqual(["1-1-a.jsonl:0"]);
    expect(absent).toEqual(["s1:snapshot_version", "s1:null"]);
    expect(notified).toBe(1);
    expect(readdirSync(dir)).toEqual(["ignored.tmp"]);
  });

  it("keeps the file when the database write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shipherd-hits-"));
    dirs.push(dir);
    writeFileSync(join(dir, "2.jsonl"), JSON.stringify(hit));
    const ing = new HitIngest({ dir, insertHits: () => { throw new Error("busy"); }, markAbsent: () => {} });
    expect(await ing.drain()).toBe(0);
    expect(readdirSync(dir)).toEqual(["2.jsonl"]);
  });
});

describe("bypass records (workstream F)", () => {
  const bypass = { kind: "bypass", checkId: 3, checkKey: "ck_1", slug: "a/b", file: "src/x.ts", line: 4, how: "suppress", detail: "// eslint-disable-next-line", session: "s1", at: 9 };

  it("parses bypass records and rejects unknown ways", () => {
    expect(parseCheckLogRecord(JSON.stringify(bypass))).toEqual(bypass);
    expect(parseCheckLogRecord(JSON.stringify({ ...bypass, file: "", line: null, how: "no_verify" }))).toMatchObject({ how: "no_verify", line: null });
    expect(parseCheckLogRecord(JSON.stringify({ ...bypass, how: "sneaky" }))).toBeNull();
    expect(parseCheckLogRecord(JSON.stringify({ ...bypass, checkKey: "" }))).toBeNull();
  });

  it("hands bypasses to insertBypasses with their own keys, separately from hits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shipherd-hits-"));
    dirs.push(dir);
    writeFileSync(join(dir, "3.jsonl"), [JSON.stringify(hit), JSON.stringify(bypass)].join("\n"));
    const hits: string[] = [];
    const bys: string[] = [];
    const ing = new HitIngest({
      dir, insertHits: (r) => (hits.push(...r.map((x) => x.key)), r.length), insertBypasses: (r) => (bys.push(...r.map((x) => `${x.key}:${x.rec.how}`)), r.length), markAbsent: () => {},
    });
    expect(await ing.drain()).toBe(2);
    expect(hits).toEqual(["3.jsonl:0"]);
    expect(bys).toEqual(["3.jsonl:1:suppress"]);
  });
});
