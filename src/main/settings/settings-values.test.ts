import { describe, expect, it } from "vitest";
import type { EditableSettingKey } from "../../shared/settings";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import { normalizeFlag, normalizeSetting, parseDays, parseTime, parseToolList, parseWorkingDays, scheduleConfig, SettingError, thresholds, trackerTools } from "./settings-values";

describe("settings values", () => {
  it("parses times, working days, day counts and tool lists", () => {
    expect(parseTime("16:00")).toEqual({ h: 16, m: 0 });
    expect(parseTime("7:05")).toEqual({ h: 7, m: 5 });
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("16")).toBeNull();
    expect([...parseWorkingDays("1, 2,5,9,x")]).toEqual([1, 2, 5]);
    expect(parseDays("3", 2)).toBe(3);
    expect(parseDays("-1", 2)).toBe(2);
    expect(parseToolList("mcp__jira__get_issue, Bash(git status)\nmcp__jira__search mcp__jira__get_issue")).toEqual([
      "mcp__jira__get_issue", "Bash(git status)", "mcp__jira__search",
    ]);
  });

  it("normalizes editable values and rejects bad ones with a SettingError", () => {
    expect(normalizeSetting("nightlyTime", "7:05")).toBe("07:05");
    expect(normalizeSetting("workingDays", "5,1,1,0")).toBe("0,1,5");
    expect(normalizeSetting("workingDays", "")).toBe("");
    expect(normalizeSetting("trackerTools", "mcp__a__x, mcp__b\n\nmcp__a__x")).toBe("mcp__a__x\nmcp__b");
    expect(normalizeSetting("staleDays", " 7 ")).toBe("7");
    expect(normalizeSetting("headlessProjectMcp", "1")).toBe("1");
    expect(normalizeSetting("headlessProjectMcp", " 0 ")).toBe("0");
    expect(() => normalizeSetting("headlessProjectMcp", "yes")).toThrow(SettingError);
    expect(() => normalizeSetting("nightlyTime", "25:00")).toThrow(SettingError);
    expect(() => normalizeSetting("workingDays", "1,7")).toThrow(SettingError);
    expect(() => normalizeSetting("blockedDays", "two")).toThrow(SettingError);
    expect(() => normalizeSetting("handoffPrompt", "   ")).toThrow(SettingError);
    try {
      normalizeSetting("nightlyTime", "x");
    } catch (e) {
      expect((e as SettingError).code).toBe("invalid_setting");
    }
  });

  it("rejects tracker tools that are not MCP tool names", () => {
    for (const bad of ["Bash", "Bash(git push:*)", "--dangerously-skip-permissions", "--permission-mode", "mcp__ok__x, Bash"]) {
      expect(() => normalizeSetting("trackerTools", bad)).toThrow(SettingError);
    }
    expect(normalizeSetting("trackerTools", "mcp__jira__get_issue mcp__linear")).toBe("mcp__jira__get_issue\nmcp__linear");
    expect(normalizeSetting("trackerTools", "")).toBe("");
  });

  it("filters a corrupt stored trackerTools value at read time", () => {
    const s = new SettingsRepo(memDb());
    s.set("trackerTools", "mcp__jira__get_issue\n--dangerously-skip-permissions\nBash\nBash(git push:*)\n--permission-mode");
    expect(trackerTools(s)).toEqual(["mcp__jira__get_issue"]);
  });

  it("reads the schedule, thresholds and tracker tools from settings", () => {
    const s = new SettingsRepo(memDb());
    expect(scheduleConfig(s)).toEqual({ nightly: { h: 16, m: 0 }, workingDays: new Set([1, 2, 3, 4, 5]) });
    expect(thresholds(s)).toEqual({ blockedDays: 2, reviewWaitDays: 2, staleDays: 5 });
    expect(trackerTools(s)).toEqual([]);
    for (const bad of ["garbage", "", "9,8"]) {
      s.set("workingDays", bad);
      expect(scheduleConfig(s).workingDays).toEqual(new Set([1, 2, 3, 4, 5]));
    }
    s.set("nightlyTime", "garbage");
    expect(scheduleConfig(s).nightly).toEqual({ h: 16, m: 0 });
  });

  it("rejects a key that is not editable even if a caller forgets the IPC gate", () => {
    expect(() => normalizeSetting("claudePath" as EditableSettingKey, "/bin/sh")).toThrow(SettingError);
  });

  it("accepts only 0 or 1 for a flag", () => {
    expect(normalizeFlag(" 1 ")).toBe("1");
    expect(normalizeFlag("0")).toBe("0");
    expect(() => normalizeFlag("yes")).toThrow(SettingError);
  });
});
