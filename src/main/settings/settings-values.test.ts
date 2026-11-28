import { describe, expect, it } from "vitest";
import type { EditableSettingKey } from "../../shared/settings";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import { FLOW_DAILY_ASKS } from "../../shared/infoflow";
import { MAIN_STRINGS } from "../strings";
import {
  auditRetentionDays, isLoopbackHost, checkBranchTemplateFits, normalizeBranchTemplate, normalizeFlag, normalizeSetting, normalizeTicketPattern, parseTime, parseToolList,
  parseWorkingDays, shipherdPatrolTime, idleCloseMinutes, sessionAdmission, refreshThreshold, scheduleConfig, SettingError, trackerTools,
  flowDailyAsks, hibernateEndWatchersOn, hibernateMinutes, hibernateOn, memoryPressureFreePercent, memoryPressureOn, sharedMcpOn,
} from "./settings-values";

describe("settings values", () => {
  it("parses times, working days and tool lists", () => {
    expect(parseTime("16:00")).toEqual({ h: 16, m: 0 });
    expect(parseTime("7:05")).toEqual({ h: 7, m: 5 });
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("16")).toBeNull();
    expect([...parseWorkingDays("1, 2,5,9,x")]).toEqual([1, 2, 5]);
    expect(parseToolList("mcp__jira__get_issue, Bash(git status)\nmcp__jira__search mcp__jira__get_issue")).toEqual([
      "mcp__jira__get_issue", "Bash(git status)", "mcp__jira__search",
    ]);
  });

  it("normalizes editable values and rejects bad ones with a SettingError", () => {
    expect(normalizeSetting("nightlyTime", "7:05")).toBe("07:05");
    expect(normalizeSetting("workingDays", "5,1,1,0")).toBe("0,1,5");
    expect(normalizeSetting("workingDays", "")).toBe("");
    expect(normalizeSetting("trackerTools", "mcp__a__x, mcp__b\n\nmcp__a__x")).toBe("mcp__a__x\nmcp__b");
    expect(normalizeSetting("headlessProjectMcp", "1")).toBe("1");
    expect(normalizeSetting("headlessProjectMcp", " 0 ")).toBe("0");
    expect(() => normalizeSetting("headlessProjectMcp", "yes")).toThrow(SettingError);
    expect(() => normalizeSetting("nightlyTime", "25:00")).toThrow(SettingError);
    expect(() => normalizeSetting("workingDays", "1,7")).toThrow(SettingError);
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

  it("reads the schedule and tracker tools from settings", () => {
    const s = new SettingsRepo(memDb());
    expect(scheduleConfig(s)).toEqual({ nightly: { h: 16, m: 0 }, workingDays: new Set([1, 2, 3, 4, 5]) });
    expect(trackerTools(s)).toEqual([]);
    for (const bad of ["garbage", "", "9,8"]) {
      s.set("workingDays", bad);
      expect(scheduleConfig(s).workingDays).toEqual(new Set([1, 2, 3, 4, 5]));
    }
    s.set("nightlyTime", "garbage");
    expect(scheduleConfig(s).nightly).toEqual({ h: 16, m: 0 });
  });

  it("rejects a key that is not editable even if a caller forgets the IPC gate", () => {
    expect(() => normalizeSetting("notARealSetting" as EditableSettingKey, "/bin/sh")).toThrow(SettingError);
  });

  it("accepts only 0 or 1 for a flag", () => {
    expect(normalizeFlag(" 1 ")).toBe("1");
    expect(normalizeFlag("0")).toBe("0");
    expect(() => normalizeFlag("yes")).toThrow(SettingError);
  });
});

describe("audit retention (BTL-243: the outward-action audit keeps it)", () => {
  it("accepts 1–3650 days and reads corrupt values back as 90", () => {
    expect(normalizeSetting("auditRetentionDays", " 30 ")).toBe("30");
    for (const bad of ["0", "3651", "-1", "ten", "1.5"]) expect(() => normalizeSetting("auditRetentionDays", bad), bad).toThrow(SettingError);
    const s = new SettingsRepo(memDb());
    expect(auditRetentionDays(s)).toBe(90);
    s.set("auditRetentionDays", normalizeSetting("auditRetentionDays", "1500"));
    expect(auditRetentionDays(s)).toBe(1500);
    s.set("auditRetentionDays", "3650");
    expect(auditRetentionDays(s)).toBe(3650);
    s.set("auditRetentionDays", "3651");
    expect(auditRetentionDays(s)).toBe(90);
  });

  it("treats only this machine as loopback (webhooks may use http there)", () => {
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
  });
});

describe("general settings (design 9, 12)", () => {
  it("accepts an empty or absolute claude path only", () => {
    expect(normalizeSetting("claudePath", "  ")).toBe("");
    expect(normalizeSetting("claudePath", " /usr/local/bin/claude ")).toBe("/usr/local/bin/claude");
    for (const bad of ["claude", "./bin/claude", "/usr/bin/cl\naude", `/${"x".repeat(1000)}`]) {
      expect(() => normalizeSetting("claudePath", bad), bad).toThrow(SettingError);
    }
  });

  it("accepts branch templates git can turn into a branch name", () => {
    for (const ok of ["feature/{key}", "{key}", "users/me/{key}-wip", "fix_{key}", "{key_lower}-{title}", "feature/{key}-{title}"]) {
      expect(normalizeBranchTemplate(ok), ok).toBe(ok);
    }
    // {title} 单独不够：没有标题时分支名就是空的。
    expect(() => normalizeBranchTemplate("{title}")).toThrow(SettingError);
    for (const bad of ["feature/", "feat ure/{key}", "-{key}", "/{key}", "feature/{key}/", "a..b/{key}", "{key}.lock", "{key}.", "a//{key}", "a/.{key}", "{ticket}/{key}", `${"x".repeat(100)}{key}`]) {
      expect(() => normalizeBranchTemplate(bad), bad).toThrow(SettingError);
    }
  });

  it("accepts ordinary ticket patterns and rejects ones that could hang the main process", () => {
    for (const ok of ["[A-Z][A-Z0-9]+-\\d+", "[A-Z]{2,10}-\\d{1,6}", "#\\d+", "(?:ENG|OPS)-\\d+", "(?:PROJ|OPS)-\\d+", "[A-Z][A-Z0-9]+-\\d+"]) expect(normalizeTicketPattern(ok), ok).toBe(ok);
    for (const bad of ["", "(", "x".repeat(101), "(a+)+", "(\\w*)*-\\d+", "([A-Z]+-?)+\\d", "(?:x{1,3})+", "(\\w)\\1", ".*", "\\d*",
      "[A-Z]+[A-Z]+[A-Z]+-\\d+", "(?:(A+))+B", "(a|a)+$", "(\\w+\\s?)+$"]) {
      expect(() => normalizeTicketPattern(bad), bad).toThrow(SettingError);
    }
  });

  it("validates the new flags through normalizeSetting", () => {
    expect(normalizeSetting("memoryEnabled", "0")).toBe("0");
    expect(normalizeSetting("onboardingDone", "1")).toBe("1");
    expect(() => normalizeSetting("memoryEnabled", "yes")).toThrow(SettingError);
    expect(normalizeSetting("branchTemplate", " feature/{key} ")).toBe("feature/{key}");
    expect(normalizeSetting("ticketPattern", " #\\d+ ")).toBe("#\\d+");
  });
});

describe("branch template against the ticket pattern", () => {
  it("rejects combinations that can render an invalid branch name", () => {
    expect(() => checkBranchTemplateFits("{key}", "-\\d+")).toThrow(SettingError);
    expect(() => checkBranchTemplateFits("{key_lower}-{title}", "[A-Z][A-Z0-9]+-\\d+")).not.toThrow();
    expect(() => checkBranchTemplateFits("{key_lower}", "-\\d+")).toThrow(SettingError);
    expect(() => checkBranchTemplateFits("{key}", "\\S+-\\d+")).toThrow(SettingError);
    expect(() => checkBranchTemplateFits("feature/{key}", "[A-Z][A-Z0-9]+-\\d+")).not.toThrow();
    expect(() => checkBranchTemplateFits("feature/{key}", "-\\d+")).not.toThrow();
  });
});

describe("language setting (design 2026-10-26 i18n)", () => {
  it("accepts auto, zh and en only", () => {
    for (const ok of ["auto", "zh", "en"]) expect(normalizeSetting("language", ` ${ok} `)).toBe(ok);
    for (const bad of ["fr", "", "ZH-cn"]) expect(() => normalizeSetting("language", bad), bad).toThrow(SettingError);
  });
});

describe("idle close minutes (BTL-190)", () => {
  it("reads idleCloseMinutes with a default of 180, 0 = off, and a broken value falls back to the default", () => {
    const s = new SettingsRepo(memDb());
    expect(idleCloseMinutes(s)).toBe(180);
    s.set("idleCloseMinutes", "45");
    expect(idleCloseMinutes(s)).toBe(45);
    s.set("idleCloseMinutes", "0");
    expect(idleCloseMinutes(s)).toBe(0);
    for (const bad of ["", "abc", "-5", "1.5", "1e3", "123456"]) {
      s.set("idleCloseMinutes", bad);
      expect(idleCloseMinutes(s), bad).toBe(180);
    }
  });

  it("accepts a whole number of minutes and rejects anything else", () => {
    expect(normalizeSetting("idleCloseMinutes", " 60 ")).toBe("60");
    expect(normalizeSetting("idleCloseMinutes", "0")).toBe("0");
    expect(normalizeSetting("idleCloseMinutes", "0090")).toBe("90");
    for (const bad of ["", "abc", "-5", "1.5", "1e3", "123456", "1", "9"]) expect(() => normalizeSetting("idleCloseMinutes", bad), bad).toThrow(SettingError);
    expect(normalizeSetting("idleCloseMinutes", "10")).toBe("10");
  });
});

describe("Shipherd 总控 daily patrol time (BTL-190 5)", () => {
  it("is off by default; empty means off and a time is stored as HH:MM", () => {
    const s = new SettingsRepo(memDb());
    expect(shipherdPatrolTime(s)).toBeNull();
    expect(normalizeSetting("shipherdPatrolTime", "  ")).toBe("");
    expect(normalizeSetting("shipherdPatrolTime", "9:05")).toBe("09:05");
    for (const bad of ["25:00", "9", "x"]) expect(() => normalizeSetting("shipherdPatrolTime", bad), bad).toThrow(SettingError);
    s.set("shipherdPatrolTime", "09:30");
    expect(shipherdPatrolTime(s)).toEqual({ h: 9, m: 30 });
    // 存坏了当作关，不猜一个时间。
    s.set("shipherdPatrolTime", "garbage");
    expect(shipherdPatrolTime(s)).toBeNull();
  });
});

describe("flowDailyAsks (BTL-272)", () => {
  it("reads the daily cap with a default of FLOW_DAILY_ASKS, and falls back on a broken value", () => {
    const s = new SettingsRepo(memDb());
    expect(flowDailyAsks(s)).toBe(FLOW_DAILY_ASKS);
    s.set("flowDailyAsks", "50");
    expect(flowDailyAsks(s)).toBe(50);
    for (const bad of ["", "abc", "0", "-5", "1.5", "10001", "1e3"]) {
      s.set("flowDailyAsks", bad);
      expect(flowDailyAsks(s), bad).toBe(FLOW_DAILY_ASKS);
    }
  });

  it("accepts 1–10000 and rejects anything else, in both languages", () => {
    expect(normalizeSetting("flowDailyAsks", " 120 ")).toBe("120");
    expect(normalizeSetting("flowDailyAsks", "1")).toBe("1");
    expect(normalizeSetting("flowDailyAsks", "10000")).toBe("10000");
    for (const bad of ["0", "10001", "-1", "abc", "", "2.5"]) expect(() => normalizeSetting("flowDailyAsks", bad), bad).toThrow(SettingError);
    expect(MAIN_STRINGS.zh.flowDailyAsks).toContain("10000");
    expect(MAIN_STRINGS.en.flowDailyAsks).toContain("10000");
  });
});

describe("refresh threshold (plan 16)", () => {
  it("reads refreshThresholdTokens with a default of 150000", () => {
    const s = new SettingsRepo(memDb());
    expect(refreshThreshold(s)).toBe(150_000);
    s.set("refreshThresholdTokens", "20000");
    expect(refreshThreshold(s)).toBe(20_000);
    // 0 = 关掉自动换新。
    s.set("refreshThresholdTokens", "0");
    expect(refreshThreshold(s)).toBe(0);
    // 存的值坏了：用默认。
    for (const bad of ["", "abc", "-5", "1.5", "1e9"]) {
      s.set("refreshThresholdTokens", bad);
      expect(refreshThreshold(s), bad).toBe(150_000);
    }
  });

  it("accepts a whole number of tokens and rejects anything else", () => {
    expect(normalizeSetting("refreshThresholdTokens", " 20000 ")).toBe("20000");
    expect(normalizeSetting("refreshThresholdTokens", "0")).toBe("0");
    expect(normalizeSetting("refreshThresholdTokens", "007")).toBe("7");
    for (const bad of ["", "abc", "-5", "1.5", "1e9", "12345678901"]) expect(() => normalizeSetting("refreshThresholdTokens", bad), bad).toThrow(SettingError);
  });
});

describe("hibernation settings (WS-M B, C)", () => {
  it("defaults: hibernation and pressure off, end watchers on, minutes 30/20/30/60, line 10%", () => {
    const s = new SettingsRepo(memDb());
    expect([hibernateOn(s), hibernateEndWatchersOn(s), memoryPressureOn(s)]).toEqual([false, true, false]);
    expect((["you", "ci", "review", "idle"] as const).map((k) => hibernateMinutes(s, k))).toEqual([30, 20, 30, 60]);
    expect(memoryPressureFreePercent(s)).toBe(10);
  });

  it("reads stored values; broken ones fall back to the default", () => {
    const s = new SettingsRepo(memDb());
    s.set("hibernateCiMinutes", "0");
    s.set("hibernateIdleMinutes", "15");
    s.set("hibernateYouMinutes", "3");
    s.set("memoryPressureFreePercent", "80");
    expect(hibernateMinutes(s, "ci")).toBe(0);
    expect(hibernateMinutes(s, "idle")).toBe(15);
    expect(hibernateMinutes(s, "you")).toBe(30);
    expect(memoryPressureFreePercent(s)).toBe(10);
  });

  it("normalizes and rejects", () => {
    expect(normalizeSetting("hibernateIdleMinutes", " 045 ")).toBe("45");
    expect(normalizeSetting("hibernateIdleMinutes", "0")).toBe("0");
    for (const bad of ["", "4", "-5", "1.5", "123456"]) expect(() => normalizeSetting("hibernateReviewMinutes", bad), bad).toThrow(SettingError);
    expect(normalizeSetting("memoryPressureFreePercent", "15")).toBe("15");
    for (const bad of ["", "0", "51", "abc", "5.5"]) expect(() => normalizeSetting("memoryPressureFreePercent", bad), bad).toThrow(SettingError);
    expect(normalizeSetting("hibernateEnabled", "1")).toBe("1");
  });

  it("reads the shared MCP switch, off by default (WS-M H)", () => {
    const s = new SettingsRepo(memDb());
    expect(sharedMcpOn(s)).toBe(false);
    s.set("sharedMcp", normalizeSetting("sharedMcp", "1"));
    expect(sharedMcpOn(s)).toBe(true);
    s.set("sharedMcp", "junk");
    expect(sharedMcpOn(s)).toBe(false);
    expect(() => normalizeSetting("sharedMcp", "yes")).toThrow(SettingError);
  });
});

describe("session admission settings (workstream W)", () => {
  it("reserve defaults to automatic (null); estimate 1024 and no cap; a broken value falls back to the default", () => {
    const s = new SettingsRepo(memDb());
    expect(sessionAdmission(s)).toEqual({ reserveMb: null, sessionMb: 1024, maxRunning: 0 });
    s.set("sessionMemoryReserveMb", "1500");
    s.set("sessionMemoryEstimateMb", "768");
    s.set("sessionMaxRunning", "12");
    expect(sessionAdmission(s)).toEqual({ reserveMb: 1500, sessionMb: 768, maxRunning: 12 });
    s.set("sessionMemoryReserveMb", "0");
    expect(sessionAdmission(s).reserveMb).toBe(0);
    for (const bad of ["abc", "-5", "1.5"]) {
      s.set("sessionMemoryReserveMb", bad);
      s.set("sessionMemoryEstimateMb", bad);
      expect(sessionAdmission(s), bad).toEqual({ reserveMb: null, sessionMb: 1024, maxRunning: 12 });
    }
  });

  it("an empty reserve means automatic; the estimate and the cap must be numbers", () => {
    expect(normalizeSetting("sessionMemoryReserveMb", "  ")).toBe("");
    expect(normalizeSetting("sessionMemoryReserveMb", " 0900 ")).toBe("900");
    expect(() => normalizeSetting("sessionMemoryReserveMb", "auto")).toThrow(SettingError);
    for (const k of ["sessionMemoryEstimateMb", "sessionMaxRunning"] as const) expect(() => normalizeSetting(k, ""), k).toThrow(SettingError);
    expect(() => normalizeSetting("sessionMemoryEstimateMb", "32")).toThrow(SettingError);
  });
});

describe("intake settings (workstream N)", () => {
  it("defaults are off and the outward switches are flags", () => {
    const s = new SettingsRepo(memDb());
    expect(s.get("intakeSource")).toBe("none");
    expect(s.get("externalIntakeTrackerComment")).toBe("0");
    expect(s.get("externalIntakeTrackerStatus")).toBe("0");
    expect(s.get("notifyEvents").split(",")).toContain("intake_decision");
    expect(normalizeSetting("externalIntakeTrackerStatus", "1")).toBe("1");
  });

  it("validates source, paths, interval and the repo map", () => {
    expect(normalizeSetting("intakeSource", " file ")).toBe("file");
    expect(() => normalizeSetting("intakeSource", "jira")).toThrow(SettingError);
    expect(normalizeSetting("intakeFilePath", "")).toBe("");
    expect(normalizeSetting("intakeFilePath", "/tmp/tickets.json")).toBe("/tmp/tickets.json");
    expect(normalizeSetting("intakeTrackerDir", "C:\\work")).toBe("C:\\work");
    expect(() => normalizeSetting("intakeFilePath", "tickets.json")).toThrow(SettingError);
    expect(normalizeSetting("intakePollMinutes", "030")).toBe("30");
    for (const v of ["4", "1441", "x", ""]) expect(() => normalizeSetting("intakePollMinutes", v), v).toThrow(SettingError);
    expect(normalizeSetting("intakeRepoMap", "PROJ => /work/app\r\n* => /work/misc\n")).toBe("PROJ => /work/app\n* => /work/misc");
    expect(() => normalizeSetting("intakeRepoMap", "PROJ => relative")).toThrow(/line 1|第 1 行/);
    expect(() => normalizeSetting("intakeTrackerQuery", "x".repeat(1001))).toThrow(SettingError);
    expect(normalizeSetting("notifyEvents", "intake_decision")).toBe("intake_decision");
  });
});

describe("reviewRequestScope setting (UI redesign layer 1)", () => {
  it("accepts all or registered, trimmed", () => {
    expect(normalizeSetting("reviewRequestScope", "all")).toBe("all");
    expect(normalizeSetting("reviewRequestScope", " registered ")).toBe("registered");
    for (const bad of ["ALL", "", "mine"]) expect(() => normalizeSetting("reviewRequestScope", bad), bad).toThrow(SettingError);
  });
});
