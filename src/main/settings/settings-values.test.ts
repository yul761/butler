import { describe, expect, it } from "vitest";
import type { EditableSettingKey } from "../../shared/settings";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import {
  isLoopbackHost, llmConfig, normalizeBaseUrl, checkBranchTemplateFits, normalizeBranchTemplate, normalizeFlag, normalizeSetting, normalizeTerms, normalizeTicketPattern, parseDays, parsePriceTable, parseTime, parseToolList,
  parseWorkingDays, priceFor, scheduleConfig, SettingError, TERMS_LIMIT, thresholds, trackerTools,
} from "./settings-values";

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
    expect(() => normalizeSetting("notARealSetting" as EditableSettingKey, "/bin/sh")).toThrow(SettingError);
  });

  it("accepts only 0 or 1 for a flag", () => {
    expect(normalizeFlag(" 1 ")).toBe("1");
    expect(normalizeFlag("0")).toBe("0");
    expect(() => normalizeFlag("yes")).toThrow(SettingError);
  });
});

describe("personal API settings", () => {
  it("accepts https base URLs, or http only for this machine, and trims the chat path", () => {
    expect(normalizeBaseUrl(" https://api.deepseek.com/v1/ ")).toBe("https://api.deepseek.com/v1");
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeBaseUrl("http://[::1]:9/v1")).toBe("http://[::1]:9/v1");
    expect(normalizeBaseUrl("")).toBe("");
    for (const bad of ["http://api.example.com/v1", "https://u:p@api.example.com", "https://api.example.com/v1?key=1", "ftp://x", "not a url"]) {
      expect(() => normalizeBaseUrl(bad), bad).toThrow(SettingError);
    }
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
  });

  it("parses the price table and matches models with * globs, first match wins", () => {
    const rules = parsePriceTable("# 注释\ndeepseek-* 0.27 1.1\n\ngpt-4.1 2 8\n* 15 75\n");
    expect(rules).toEqual([
      { pattern: "deepseek-*", inputPerMTok: 0.27, outputPerMTok: 1.1 },
      { pattern: "gpt-4.1", inputPerMTok: 2, outputPerMTok: 8 },
      { pattern: "*", inputPerMTok: 15, outputPerMTok: 75 },
    ]);
    expect(priceFor(rules, "DeepSeek-Chat")?.inputPerMTok).toBe(0.27);
    expect(priceFor(rules, "gpt-4.1")?.inputPerMTok).toBe(2);
    expect(priceFor(rules, "gpt-421")?.pattern).toBe("*");
    expect(priceFor(rules.slice(0, 2), "llama3")).toBeNull();
    for (const bad of ["gpt 1", "gpt one 2", "gpt 1 2 3", "gpt -1 2"]) expect(() => parsePriceTable(bad), bad).toThrow(SettingError);
  });

  it("normalizes and validates the personal API settings", () => {
    expect(normalizeSetting("llmLevel", " redacted ")).toBe("redacted");
    expect(() => normalizeSetting("llmLevel", "secret")).toThrow(SettingError);
    expect(normalizeSetting("llmModel", " deepseek-chat ")).toBe("deepseek-chat");
    expect(normalizeSetting("llmModel", "")).toBe("");
    expect(() => normalizeSetting("llmModel", "deep seek")).toThrow(SettingError);
    expect(normalizeSetting("llmMonthlyBudgetUsd", "2.50")).toBe("2.5");
    expect(() => normalizeSetting("llmMonthlyBudgetUsd", "-1")).toThrow(SettingError);
    expect(normalizeSetting("llmPrices", "# x\ngpt-4o-mini  0.15   0.6")).toBe("gpt-4o-mini 0.15 0.6");
    expect(normalizeSetting("llmPrices", "")).toBe("");
    expect(normalizeSetting("llmConfirm", "1")).toBe("1");
    expect(normalizeSetting("auditRetentionDays", "30")).toBe("30");
    expect(() => normalizeSetting("auditRetentionDays", "0")).toThrow(SettingError);
    expect(normalizeSetting("llmBaseUrl", "https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/v1");
  });

  it("reads the config with safe fallbacks for corrupt stored values", () => {
    const s = new SettingsRepo(memDb());
    expect(llmConfig(s)).toEqual({
      level: "metadata", baseUrl: "", model: "", budgetUsd: 1,
      prices: [{ pattern: "*", inputPerMTok: 15, outputPerMTok: 75 }], confirm: false, retentionDays: 90,
    });
    s.set("llmLevel", "everything");
    s.set("llmBaseUrl", "http://api.example.com");
    s.set("llmPrices", "garbage");
    s.set("llmMonthlyBudgetUsd", "lots");
    s.set("auditRetentionDays", "0");
    expect(llmConfig(s)).toMatchObject({ level: "off", baseUrl: "", prices: [], budgetUsd: 0, retentionDays: 90 });
  });

  it("normalizes the sensitive term list", () => {
    expect(
      normalizeTerms([
        { term: " 张三 ", category: "person" },
        { term: "Ｐｒｏｊｅｃｔ  Falcon", category: "term" },
        { term: "project falcon", category: "term" },
        { term: "  ", category: "term" },
      ]),
    ).toEqual([{ term: "张三", category: "person" }, { term: "Project Falcon", category: "term" }]);
    expect(() => normalizeTerms([{ term: "王", category: "person" }])).toThrow(SettingError);
    expect(() => normalizeTerms([{ term: "x".repeat(101), category: "term" }])).toThrow(SettingError);
    expect(() => normalizeTerms([{ term: "ab", category: "boss" }])).toThrow(SettingError);
    expect(() => normalizeTerms("张三")).toThrow(SettingError);
    expect(() => normalizeTerms(Array.from({ length: TERMS_LIMIT + 1 }, (_, i) => ({ term: `词${i}号`, category: "term" })))).toThrow(SettingError);
  });

  it("round-trips retention days up to 3650 and matches pathological patterns in linear time", () => {
    const s = new SettingsRepo(memDb());
    s.set("auditRetentionDays", normalizeSetting("auditRetentionDays", "1500"));
    expect(llmConfig(s).retentionDays).toBe(1500);
    s.set("auditRetentionDays", "3650");
    expect(llmConfig(s).retentionDays).toBe(3650);
    s.set("auditRetentionDays", "3651");
    expect(llmConfig(s).retentionDays).toBe(90);
    const rules = parsePriceTable(`${"*".repeat(25)}x 1 2`);
    const t0 = performance.now();
    expect(priceFor(rules, "a".repeat(60))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
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
