import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskMessage } from "../shared/control";
import { SettingsRepo } from "./db/settings-repo";
import { narrativeMessages } from "./gateway/narrative";
import { handoffCommandPath, handoffCommandStatus, installHandoffCommand } from "./handoff/command";
import { buildPrompt, retryPrompt } from "./handoff/prompt";
import { DEFAULT_HANDOFF_PROMPT, defaultHandoffPrompt, defaultRefreshPrompt } from "./handoff/templates";
import { setLang } from "./i18n";
import { followupNote, handoffSummaryFor } from "./memory/notes";
import { memDb, tempDir } from "./test-utils";

const hasChinese = (s: string) => /[一-鿿]/.test(s);

afterEach(() => setLang("zh"));

describe("prompts follow the language (design 2026-10-26 i18n)", () => {
  it("serves the English default prompts in English, also when the Chinese default was saved unchanged", () => {
    const settings = new SettingsRepo(memDb());
    setLang("en");
    expect(settings.get("handoffPrompt")).toBe(defaultHandoffPrompt("en"));
    expect(settings.get("refreshPrompt")).toBe(defaultRefreshPrompt("en"));
    settings.set("handoffPrompt", DEFAULT_HANDOFF_PROMPT);
    expect(settings.get("handoffPrompt")).toBe(defaultHandoffPrompt("en"));
    settings.set("handoffPrompt", "my own prompt {{ticket}}");
    expect(settings.get("handoffPrompt")).toBe("my own prompt {{ticket}}");
    setLang("zh");
    expect(settings.get("refreshPrompt")).toBe(defaultRefreshPrompt("zh"));
  });

  it("builds an English handoff prompt with no Chinese in it", () => {
    setLang("en");
    const ticket = { key: "DMS-1", title: null, repos: [], status: "active" as const, statusManual: null, createdAt: 1, archivedAt: null, featureId: null };
    const p = buildPrompt(defaultHandoffPrompt("en"), { ticket, status: "active", previous: null, openFollowups: [], trackerTools: [] });
    expect(hasChinese(p)).toBe(false);
    expect(hasChinese(retryPrompt(p, "bad"))).toBe(false);
    expect(hasChinese(defaultRefreshPrompt("en"))).toBe(false);
  });

  it("marks the other language's /handoff command as stale, and installs the current one", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "commands"));
    const file = handoffCommandPath(join(dir, "commands"));
    await installHandoffCommand(file);
    expect(await handoffCommandStatus(file)).toBe("installed");
    setLang("en");
    expect(await handoffCommandStatus(file)).toBe("stale");
    expect(await installHandoffCommand(file)).toBe("installed");
    expect(hasChinese(readFileSync(file, "utf8"))).toBe(false);
  });

  it("writes the coordinator's task, today's focus prompt and memory notes in English", () => {
    expect(taskMessage("build it", "en")).toBe("Task from the coordinator session:\nbuild it");
    expect(taskMessage("build it", "zh")).toBe("总控 session 交给你的任务：\nbuild it");
    setLang("en");
    const system = narrativeMessages({} as never)[0].content;
    expect(hasChinese(system)).toBe(false);
    expect(system).toContain("in English");
    const f = { id: "f1", ticketKey: "A-1", kind: "config" as const, description: "raise the TTL", trigger: "after_merge" as const, dueDate: null, status: "open" as const, snoozedUntil: null, source: "session" as const, createdAt: 1, doneAt: null };
    expect(followupNote(f).body).toBe("raise the TTL (config, after merge)");
    expect(handoffSummaryFor({ status: "done", done_today: ["a", "b"] })).toBe("Status: done. Done: a; b");
  });
});
