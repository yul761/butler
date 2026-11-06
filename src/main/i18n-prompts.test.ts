import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskMessage } from "../shared/control";
import { SettingsRepo } from "./db/settings-repo";
import { handoffCommandPath, handoffCommandStatus, installHandoffCommand } from "./handoff/command";
import { buildPrompt, retryPrompt } from "./handoff/prompt";
import { DEFAULT_HANDOFF_PROMPT, defaultHandoffPrompt, defaultRefreshPrompt, handoffCommandBody } from "./handoff/templates";
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

  it("no longer mentions the brief, and still treats a saved copy of the old default as the default", () => {
    const settings = new SettingsRepo(memDb());
    for (const lang of ["zh", "en"] as const) {
      setLang(lang);
      expect(defaultHandoffPrompt(lang)).not.toMatch(/简报|brief/i);
      expect(handoffCommandBody(lang)).not.toMatch(/简报|brief/i);
      // 旧版本的默认 prompt 原样存下来过（点过保存但没改）：照样当成默认，跟着语言和新文字走。
      const old = lang === "zh"
        ? DEFAULT_HANDOFF_PROMPT.replace("供之后的 session 和记忆使用。", "供明天早上的简报使用。")
        : defaultHandoffPrompt("en").replace("for later sessions and memory.", "for tomorrow morning's brief.");
      expect(old).not.toBe(defaultHandoffPrompt(lang));
      settings.set("handoffPrompt", old);
      expect(settings.get("handoffPrompt")).toBe(defaultHandoffPrompt(lang));
    }
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

  it("writes the coordinator's task and memory notes in English", () => {
    expect(taskMessage("build it", "en", "feature")).toBe("Task from the coordinator session:\nbuild it\n\nRead the background and agreements from the feature memory (butler-feature) with recall before you start.");
    expect(taskMessage("build it", "en", "ticket")).toContain("(butler-memory)");
    expect(taskMessage("build it", "zh", "feature")).toBe("总控 session 交给你的任务：\nbuild it\n\n开始之前先用 recall 读一下 feature 记忆（butler-feature）里的背景和约定。");
    expect(taskMessage("build it", "zh", "ticket")).toContain("ticket 记忆（butler-memory）");
    setLang("en");
    const f = { id: "f1", ticketKey: "A-1", kind: "config" as const, description: "raise the TTL", trigger: "after_merge" as const, dueDate: null, status: "open" as const, snoozedUntil: null, source: "session" as const, createdAt: 1, doneAt: null };
    expect(followupNote(f).body).toBe("raise the TTL (config, after merge)");
    expect(handoffSummaryFor({ status: "done", done_today: ["a", "b"] })).toBe("Status: done. Done: a; b");
  });
});
