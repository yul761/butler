import { describe, expect, it } from "vitest";
import { classifyCiByRule, failedStep, failedTests, failureSignature, jobVerdict, parseLog, type RunFailure } from "./ci-rules";
import type { RunInfo } from "../tickets/gh-loop";

const cfg = { envPatterns: [], codePatterns: [], flaky: [] };
const gh = (step: string, text: string): string => `test\t${step}\t2026-11-17T10:00:00.1234567Z ${text}`;
const run = (log: string | null, info: RunInfo | null = null, checks = ["test"]): RunFailure => ({ runId: 1, checks, log, info });
const info = (over: Partial<RunInfo> = {}): RunInfo => ({ attempt: 1, status: "completed", conclusion: "failure", jobs: [], ...over });

describe("parseLog", () => {
  it("splits job, step and strips the timestamp and colours on both line endings", () => {
    expect(parseLog(`${gh("Run tests", "\u001b[31mboom\u001b[0m")}\r\nplain`)).toEqual([
      { job: "test", step: "Run tests", text: "boom" },
      { job: null, step: null, text: "plain" },
    ]);
  });
});

describe("jobVerdict", () => {
  it("treats runner-level failures as environment", () => {
    expect(jobVerdict(info({ conclusion: "startup_failure" }))?.reason).toBe("job:startup_failure");
    expect(jobVerdict(info({ conclusion: "cancelled" }))?.reason).toBe("job:cancelled");
    expect(jobVerdict(info({ jobs: [{ name: "a", status: "completed", conclusion: "failure", startedAt: null, completedAt: null, steps: [] }] }))?.reason).toBe("job:no_steps");
    expect(jobVerdict(info({ jobs: [{ name: "a", status: "completed", conclusion: "failure", startedAt: null, completedAt: null, steps: [{ name: "Set up job", conclusion: "failure", number: 1 }] }] }))?.reason).toBe("job:runner_setup");
    expect(jobVerdict(info({ jobs: [{ name: "a", status: "completed", conclusion: "failure", startedAt: null, completedAt: null, steps: [{ name: "Test", conclusion: "failure", number: 4 }] }] }))).toBeNull();
    expect(jobVerdict(null)).toBeNull();
  });
});

describe("classifyCiByRule", () => {
  it("finds network timeouts", () => {
    expect(classifyCiByRule(run(gh("Install", "npm ERR! code ETIMEDOUT")), cfg)).toEqual({ category: "env", source: "rule", reason: "env:ETIMEDOUT" });
    expect(classifyCiByRule(run(gh("Install", "ERR_PNPM_FETCH_404")), cfg)?.category).toBe("env");
  });

  it("prefers code keywords over environment ones", () => {
    const log = [gh("Test", "src/a.test.ts(3,1): error TS2322: nope"), gh("Test", "ECONNRESET while uploading")].join("\n");
    expect(classifyCiByRule(run(log), cfg)).toEqual({ category: "code", source: "rule", reason: "code:/error TS\\d+/" });
  });

  it("uses the flaky list before keywords, on check names and test names", () => {
    const log = gh("Test", " FAIL  src/a.test.ts > retries > waits");
    expect(classifyCiByRule(run(log), { ...cfg, flaky: ["src/a.test.ts > retries > waits"] })).toEqual({ category: "flaky", source: "list", reason: "list:src/a.test.ts > retries > waits" });
    expect(classifyCiByRule(run("x", null, ["e2e (macos)"]), { ...cfg, flaky: ["/^e2e/"] })?.category).toBe("flaky");
  });

  it("applies user patterns", () => {
    expect(classifyCiByRule(run(gh("Deploy", "quota hiccup")), { ...cfg, envPatterns: ["quota hiccup"] })?.reason).toBe("env:quota hiccup");
    expect(classifyCiByRule(run(gh("Deploy", "ETIMEDOUT but schema drift")), { ...cfg, codePatterns: ["schema drift"] })?.category).toBe("code");
  });

  it("treats network-looking failures in install steps as environment", () => {
    expect(classifyCiByRule(run(gh("Install dependencies", "registry returned garbage after timeout")), cfg)?.reason).toBe("step:Install dependencies");
  });

  it("leaves the rest to the model", () => {
    expect(classifyCiByRule(run(gh("Build", "something odd happened")), cfg)).toBeNull();
    expect(classifyCiByRule(run(null), cfg)).toBeNull();
  });
});

describe("failedTests", () => {
  it("reads vitest, jest, pytest, go and playwright output", () => {
    const log = [
      " FAIL  src/a.test.ts > suite > one",
      "FAILED tests/test_b.py::test_two - AssertionError",
      "--- FAIL: TestThree (0.01s)",
      "  ✘  4 [chromium] › e2e/x.spec.ts:3:1 › four (2.1s)",
      "  1) [chromium] › e2e/y.spec.ts:9:5 › five",
      "  ● Suite › six",
    ].map((t) => gh("Test", t)).join("\n");
    expect(failedTests(log)).toEqual(["src/a.test.ts > suite > one", "tests/test_b.py::test_two", "TestThree", "e2e/x.spec.ts:3:1 › four", "e2e/y.spec.ts:9:5 › five", "Suite › six"]);
  });
});

describe("failureSignature", () => {
  it("ignores timestamps, numbers and hashes", () => {
    const a = failureSignature(["test"], gh("Install", "ETIMEDOUT after 30012ms fetching abcdef1234"));
    const b = failureSignature(["test"], "test\tInstall\t2026-11-18T01:02:03.0000000Z ETIMEDOUT after 29999ms fetching 9876543fed");
    expect(a).toBe(b);
    expect(failureSignature(["test"], gh("Install", "ECONNRESET"))).not.toBe(a);
    expect(failureSignature(["lint"], gh("Install", "ETIMEDOUT after 1ms fetching abcdef1234"))).not.toBe(a);
  });
});

describe("failedStep", () => {
  it("reads the step from job info, then from the log", () => {
    expect(failedStep(run(null, info({ jobs: [{ name: "a", status: "", conclusion: "failure", startedAt: null, completedAt: null, steps: [{ name: "Lint", conclusion: "failure", number: 2 }] }] })))).toBe("Lint");
    expect(failedStep(run(gh("Run tests", "x")))).toBe("Run tests");
    expect(failedStep(run(null))).toBeNull();
  });
});
