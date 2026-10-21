import { describe, expect, it } from "vitest";
import { EMPTY_BRIEF_CONTENT, type Brief, type BriefKind } from "../../shared/brief";
import { JOB_EVENING, JobsRepo } from "../db/jobs-repo";
import { memDb } from "../test-utils";
import { morningJob, nightlyJob, type DailyJobDeps } from "./daily-jobs";

const brief = (kind: BriefKind, withContent = true): Brief => ({
  id: 1, kind, date: "2026-10-21", createdAt: 1, ...EMPTY_BRIEF_CONTENT,
  evening: kind === "evening" && withContent ? [{ ticketKey: "A-1", done: ["x"], blockers: [], next: null, degraded: false }] : [],
  narrative: null, narrativeStatus: "off",
});

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
    briefs: {
      generateMorning: () => {
        calls.push("morning");
        return brief("morning");
      },
      generateEvening: () => {
        calls.push("evening");
        return brief("evening");
      },
    },
    jobs,
    now: () => 123,
    isWorkingDay: () => true,
    setRefreshing: (v) => calls.push(`refreshing=${v}`),
    onEvening: (b) => calls.push(`notify:${b.kind}`),
    ...over,
  };
  return { d, calls, jobs };
}

describe("daily jobs", () => {
  it("nightly: batch, then the evening summary and a notification", async () => {
    const { d, calls, jobs } = deps();
    expect(await nightlyJob(d)).toBe("partial");
    expect(calls).toEqual(["runNightly", "evening", "notify:evening"]);
    expect(jobs.get(JOB_EVENING)).toMatchObject({ lastRunAt: 123, lastStatus: "ok" });
  });

  it("morning: a quick brief from current data first, then refresh and regenerate on working days", async () => {
    const { d, calls } = deps();
    await morningJob(d);
    expect(calls).toEqual(["morning", "refreshing=true", "refresh", "morning", "refreshing=false"]);
  });

  it("morning: no refresh on days off, and the flag is cleared even if refresh fails", async () => {
    const off = deps({ isWorkingDay: () => false });
    await morningJob(off.d);
    expect(off.calls).toEqual(["morning"]);
    const failing = deps();
    failing.d.runner = {
      ...failing.d.runner,
      refreshForBrief: async () => {
        throw new Error("boom");
      },
    };
    await expect(morningJob(failing.d)).rejects.toThrow("boom");
    expect(failing.calls).toEqual(["morning", "refreshing=true", "refreshing=false"]);
  });

  it("turns a synchronous throw from the runner into a rejection and still clears the flag", async () => {
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
    expect(morning.calls).toEqual(["morning", "refreshing=true", "refreshing=false"]);
  });

  it("nightly: no notification for an empty brief or for catching up an earlier day's slot", async () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
    const empty = deps({ now: () => at(20, 16) });
    empty.d.briefs = { ...empty.d.briefs, generateEvening: () => brief("evening", false) };
    await nightlyJob(empty.d, at(20, 16));
    expect(empty.calls).toEqual(["runNightly"]);
    const late = deps({ now: () => at(21, 8) });
    await nightlyJob(late.d, at(20, 16));
    expect(late.calls).toEqual(["runNightly", "evening"]);
    const today = deps({ now: () => at(20, 16) });
    await nightlyJob(today.d, at(20, 16));
    expect(today.calls).toEqual(["runNightly", "evening", "notify:evening"]);
  });
});
