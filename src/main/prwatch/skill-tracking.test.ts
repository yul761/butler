import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import { ensureSkillTrackingSince, skillTrackingSince } from "./skill-tracking";

const setup = () => ({ settings: new SettingsRepo(memDb()) });

describe("skill tracking start", () => {
  it("is null until seeded", () => {
    expect(skillTrackingSince(setup().settings)).toBeNull();
  });
  it("seeds from the earliest skill event", () => {
    const { settings } = setup();
    expect(ensureSkillTrackingSince({ settings, firstSkillAt: () => 100, now: () => 500 })).toBe(100);
    expect(skillTrackingSince(settings)).toBe(100);
  });
  it("seeds now with no events", () => {
    const { settings } = setup();
    expect(ensureSkillTrackingSince({ settings, firstSkillAt: () => null, now: () => 500 })).toBe(500);
  });
  it("seeds now when the earliest event is in the future", () => {
    const { settings } = setup();
    expect(ensureSkillTrackingSince({ settings, firstSkillAt: () => 900, now: () => 500 })).toBe(500);
  });
  it("never moves once set", () => {
    const { settings } = setup();
    ensureSkillTrackingSince({ settings, firstSkillAt: () => null, now: () => 500 });
    expect(ensureSkillTrackingSince({ settings, firstSkillAt: () => 10, now: () => 900 })).toBe(500);
    expect(skillTrackingSince(settings)).toBe(500);
  });
});
