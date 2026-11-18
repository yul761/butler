import { describe, expect, it } from "vitest";
import { runRegexJobs } from "./regex-worker";

describe("runRegexJobs (user regexes under a deadline)", () => {
  it("tests every text against every job", async () => {
    const r = await runRegexJobs([{ pattern: "foo\\(", flags: "", texts: ["foo(1)", "bar"] }, { pattern: "BAR", flags: "i", texts: ["bar"] }], 2000);
    expect(r).toEqual({ ok: true, results: [[true, false], [true]] });
  });

  it("a regex that does not compile matches nothing", async () => {
    expect(await runRegexJobs([{ pattern: "(", flags: "", texts: ["("] }], 2000)).toEqual({ ok: true, results: [[false]] });
  });

  it("no jobs: no worker", async () => {
    expect(await runRegexJobs([], 2000)).toEqual({ ok: true, results: [] });
  });

  it("catastrophic backtracking is cut off at the deadline", async () => {
    const started = Date.now();
    const r = await runRegexJobs([{ pattern: "^(\\w+\\s?)+$", flags: "", texts: ["a".repeat(40) + "!"] }], 300);
    expect(r).toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
