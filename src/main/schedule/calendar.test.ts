import { describe, expect, it } from "vitest";
import { addDays, atTime, daysBetween, dayStart, isFirstWorkingDayOfWeek, isWorkingDay, localDate, previousWorkingDay, weekday } from "./calendar";

describe("calendar", () => {
  it("formats and parses local dates", () => {
    expect(localDate(new Date(2026, 9, 21, 23, 59).getTime())).toBe("2026-10-21");
    expect(dayStart("2026-10-21")).toBe(new Date(2026, 9, 21).getTime());
    expect(atTime("2026-10-21", 16, 0)).toBe(new Date(2026, 9, 21, 16, 0).getTime());
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekday("2026-10-19")).toBe(1);
  });

  it("finds the previous working day (Monday looks back to Friday)", () => {
    const weekdays = new Set([1, 2, 3, 4, 5]);
    expect(previousWorkingDay("2026-10-19", weekdays)).toBe("2026-10-16");
    expect(previousWorkingDay("2026-10-21", weekdays)).toBe("2026-10-20");
    expect(previousWorkingDay("2026-10-18", new Set([0, 1, 2, 3, 4]))).toBe("2026-10-15");
    expect(previousWorkingDay("2026-10-21", new Set())).toBe("2026-10-20");
    expect(isWorkingDay("2026-10-17", weekdays)).toBe(false);
    expect(isWorkingDay("2026-10-16", weekdays)).toBe(true);
  });

  it("finds the first working day of the week: the one right after the days off", () => {
    const weekdays = new Set([1, 2, 3, 4, 5]);
    // 2026-10-19 是周一。
    expect(isFirstWorkingDayOfWeek("2026-10-19", weekdays)).toBe(true);
    for (const d of ["2026-10-20", "2026-10-23", "2026-10-24", "2026-10-25"]) expect(isFirstWorkingDayOfWeek(d, weekdays), d).toBe(false);
    // 周日到周四上班：周日是第一个工作日。
    expect(isFirstWorkingDayOfWeek("2026-10-18", new Set([0, 1, 2, 3, 4]))).toBe(true);
    expect(isFirstWorkingDayOfWeek("2026-10-19", new Set([0, 1, 2, 3, 4]))).toBe(false);
    // 不连续的工作日：从周一往后数第一个接在休息日后面的。
    expect(isFirstWorkingDayOfWeek("2026-10-19", new Set([1, 3, 5]))).toBe(true);
    expect(isFirstWorkingDayOfWeek("2026-10-21", new Set([1, 3, 5]))).toBe(false);
    // 周二到周六上班：周二。
    expect(isFirstWorkingDayOfWeek("2026-10-20", new Set([2, 3, 4, 5, 6]))).toBe(true);
    // 天天上班：周一；没有工作日：永远不是。
    expect(isFirstWorkingDayOfWeek("2026-10-19", new Set([0, 1, 2, 3, 4, 5, 6]))).toBe(true);
    expect(isFirstWorkingDayOfWeek("2026-10-18", new Set([0, 1, 2, 3, 4, 5, 6]))).toBe(false);
    expect(isFirstWorkingDayOfWeek("2026-10-19", new Set())).toBe(false);
  });

  it("counts whole local days, unaffected by daylight-saving changes", () => {
    expect(daysBetween(new Date(2026, 2, 7, 23, 0).getTime(), new Date(2026, 2, 9, 1, 0).getTime())).toBe(2);
    expect(daysBetween(new Date(2026, 9, 24, 12).getTime(), new Date(2026, 9, 26, 8).getTime())).toBe(2);
    expect(daysBetween(new Date(2026, 9, 31, 12).getTime(), new Date(2026, 10, 2, 8).getTime())).toBe(2);
    expect(daysBetween(new Date(2026, 9, 21, 0, 1).getTime(), new Date(2026, 9, 21, 23, 59).getTime())).toBe(0);
  });

  // The runner's TZ decides whether this exercises a real DST switch. The gate checks that the
  // offset changes between Mar 7 and Mar 9 2026 (US/Canada spring-forward), so it runs under
  // e.g. TZ=America/New_York and skips under UTC, Asia/*, Europe/* (their switch is on Mar 29).
  const observesDst = new Date(2026, 2, 7).getTimezoneOffset() !== new Date(2026, 2, 9).getTimezoneOffset();
  it.skipIf(!observesDst)("handles the spring-forward day, where the local day is 23 hours long", () => {
    const from = new Date(2026, 2, 8, 0, 30).getTime();
    const hours = (new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime()) / 3_600_000;
    expect(hours).toBe(23);
    expect(daysBetween(from, new Date(2026, 2, 9, 0, 30).getTime())).toBe(1);
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(atTime("2026-03-08", 16, 0)).toBe(new Date(2026, 2, 8, 16, 0).getTime());
  });
});
