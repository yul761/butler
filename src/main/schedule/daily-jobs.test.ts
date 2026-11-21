import { describe, expect, it } from "vitest";
import { JobsRepo } from "../db/jobs-repo";
import { memDb } from "../test-utils";
import { morningJob, nightlyJob, type DailyJobDeps } from "./daily-jobs";

function deps(over: Partial<DailyJobDeps> = {}) {
  const calls: string[] = [];
  const jobs = new JobsRepo(memDb());
  const d: DailyJobDeps = {
    runner: {
      runNightly: async () => {
        calls.push("runNightly");
        return { status: "partial", outcomes: [] };
      },
      refreshForBrief: async () => {
        calls.push("refresh");
        return { status: "ok", outcomes: [{ ticketKey: "A-1", status: "stored", handoffId: 1, degraded: false }] };
      },
    },
    isWorkingDay: () => true,
    hasTrackerTools: () => true,
    ...over,
  };
  return { d, calls, jobs };
}

describe("daily jobs", () => {
  it("nightly: just the handoff batch, no evening summary or notification", async () => {
    const { d, calls } = deps();
    expect(await nightlyJob(d)).toBe("partial");
    expect(calls).toEqual(["runNightly"]);
  });

  describe("feature summaries", () => {
    const okTickets = (calls: string[], outcomes: Awaited<ReturnType<DailyJobDeps["runner"]["runNightly"]>>["outcomes"] = []) => ({
      runNightly: async () => {
        calls.push("runNightly");
        return { status: "ok" as const, outcomes };
      },
      refreshForBrief: async () => ({ status: "ok" as const, outcomes: [] }),
    });
    const featureRunner = (calls: string[], status: "ok" | "partial" = "ok") => ({
      runNightly: async () => {
        calls.push("features");
        return { status, outcomes: [] };
      },
    });

    it("runs after the ticket batch", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls);
      d.features = featureRunner(calls);
      expect(await nightlyJob(d)).toBe("ok");
      expect(calls).toEqual(["runNightly", "features"]);
    });

    it("is skipped when the ticket batch was rate limited, and the job is partial", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls, [
        { ticketKey: "A-1", status: "stored", handoffId: 1, degraded: false },
        { ticketKey: "A-2", status: "skipped", reason: "rate_limited" },
      ]);
      d.features = featureRunner(calls);
      expect(await nightlyJob(d)).toBe("partial");
      expect(calls).toEqual(["runNightly"]);
    });

    it("a partial feature batch makes the job partial", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls);
      d.features = featureRunner(calls, "partial");
      expect(await nightlyJob(d)).toBe("partial");
      expect(calls).toEqual(["runNightly", "features"]);
    });

    it("a partial ticket batch (not rate limited) still runs the features and stays partial", async () => {
      const { d, calls } = deps();
      d.features = featureRunner(calls);
      expect(await nightlyJob(d)).toBe("partial");
      expect(calls).toEqual(["runNightly", "features"]);
    });

    it("a feature batch that rejects or throws only logs, and the job is partial", async () => {
      for (const fail of ["reject", "throw"] as const) {
        const { d, calls } = deps();
        const logs: [string, unknown][] = [];
        d.runner = okTickets(calls);
        d.log = (msg, err) => void logs.push([msg, err]);
        const boom = new Error("db locked");
        d.features = {
          runNightly: () => {
            calls.push("features");
            if (fail === "throw") throw boom;
            return Promise.reject(boom);
          },
        };
        expect(await nightlyJob(d)).toBe("partial");
        await Promise.resolve();
        expect(calls).toEqual(["runNightly", "features"]);
        expect(logs).toEqual([["nightly feature summaries failed", boom]]);
      }
    });

    it("a feature batch failure without a log function is still only partial", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls);
      d.features = { runNightly: () => Promise.reject(new Error("x")) };
      expect(await nightlyJob(d)).toBe("partial");
      expect(calls).toEqual(["runNightly"]);
    });

    it("without features the job is unchanged", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls);
      expect(await nightlyJob(d)).toBe("ok");
      expect(calls).toEqual(["runNightly"]);
    });
  });

  it("morning: refreshes tracker state on working days when tracker tools are configured", async () => {
    const { d, calls } = deps();
    await morningJob(d);
    expect(calls).toEqual(["refresh"]);
  });

  it("morning: nothing to do without tracker tools (PR state comes from the watcher) or on days off", async () => {
    const noTools = deps({ hasTrackerTools: () => false });
    await morningJob(noTools.d);
    expect(noTools.calls).toEqual([]);
    const off = deps({ isWorkingDay: () => false });
    await morningJob(off.d);
    expect(off.calls).toEqual([]);
  });

  it("morning: a failing refresh is handed to the scheduler", async () => {
    const failing = deps();
    failing.d.runner = {
      ...failing.d.runner,
      refreshForBrief: async () => {
        throw new Error("boom");
      },
    };
    await expect(morningJob(failing.d)).rejects.toThrow("boom");
  });

  it("turns a synchronous throw from the runner into a rejection", async () => {
    const boom = () => {
      throw new Error("sync boom");
    };
    const nightly = deps();
    nightly.d.runner = { runNightly: boom, refreshForBrief: boom };
    await expect(nightlyJob(nightly.d)).rejects.toThrow("sync boom");
    expect(nightly.calls).toEqual([]);
    const morning = deps();
    morning.d.runner = { runNightly: boom, refreshForBrief: boom };
    await expect(morningJob(morning.d)).rejects.toThrow("sync boom");
  });
});
