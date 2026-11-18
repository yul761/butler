import { describe, expect, it } from "vitest";
import { setupAdmission } from "./__fixtures__/setup";
import { CALIBRATION_PER_BAND, CalibrationService } from "./calibration";

function build() {
  const s = setupAdmission();
  let at = "";
  const cal = new CalibrationService({
    db: s.db, repo: s.repo, policy: () => s.policies.resolve({ kind: "global" }).value, now: () => s.clock.now,
    calibratedAt: () => at, setCalibratedAt: (v) => (at = v), seed: () => 7,
  });
  const scored = (score: number, checkability: "prose" | "checkable" = "checkable", slug = "acme/web") => {
    const id = s.lesson(`lesson ${score} ${Math.random()}`, { slug });
    s.repo.setFields(id, { score, checkability, scoreParts: { evidence: { value: score, reason: "r" } } }, 1);
    return id;
  };
  return { ...s, cal, scored };
}

describe("CalibrationService", () => {
  it("draws up to five per band, using the stricter line for prose lessons", () => {
    const s = build();
    for (let i = 0; i < 7; i++) s.scored(0.9);
    const prose = s.scored(0.75, "prose"); // 过了检查线、没过文字线：中间
    for (let i = 0; i < 2; i++) s.scored(0.5);
    for (let i = 0; i < 6; i++) s.scored(0.1);
    s.scored(0.9, "checkable", "acme/api");
    const sample = s.cal.sample({ kind: "repo", slug: "acme/web" });
    const count = (b: string) => sample.items.filter((i) => i.band === b).length;
    expect([count("high"), count("mid"), count("low")]).toEqual([CALIBRATION_PER_BAND, 3, CALIBRATION_PER_BAND]);
    expect(sample.items.find((i) => i.lessonId === prose)).toMatchObject({ band: "mid", auto: "shelve" });
    expect(s.cal.sample({ kind: "repo", slug: "acme/web" }).items).toEqual(sample.items);
  });

  it("puts a lesson exactly on the drop line in the middle band and treats low clarity as shelved", () => {
    const s = build();
    const p = s.policies.resolve({ kind: "global" }).value;
    const onDrop = s.scored(Number(p["score.dropLine"]));
    const unclear = s.lesson("unclear high", {});
    s.repo.setFields(unclear, { score: 0.95, checkability: "checkable", scoreParts: { clarity: { value: 0, reason: "vague" } } }, 1);
    const items = s.cal.sample({ kind: "all" }).items;
    expect(items.find((i) => i.lessonId === onDrop)).toMatchObject({ band: "mid", auto: "shelve" });
    expect(items.find((i) => i.lessonId === unclear)).toMatchObject({ band: "high", auto: "shelve" });
  });

  it("records marks as review samples and computes agreement", () => {
    const s = build();
    const hi = s.scored(0.9);
    const lo = s.scored(0.1);
    const mid = s.scored(0.5);
    const other = s.scored(0.6);
    const since = s.cal.sample({ kind: "repo", slug: "acme/web" }).drawnAt;
    // since 只认发出去的抽样；更早的判断不能借一个假的 since 删掉。
    expect(s.cal.mark(hi, "good", 0)).toEqual({ ok: false, reason: "not_in_sample" });
    void other;
    s.cal.mark(hi, "good", since);
    s.cal.mark(lo, "good", since);
    s.cal.mark(mid, "bad", since);
    s.cal.mark(mid, "skip", since); // 改判成跳过：撤掉上一个
    s.cal.mark(lo, "bad", since);
    expect(s.cal.marks(since)).toEqual({ [hi]: "good", [lo]: "bad" });
    const rows = s.db.prepare(`SELECT lesson_id, auto_verdict, human_verdict, source FROM score_calibration ORDER BY lesson_id`).all();
    expect(rows).toEqual([
      { lesson_id: hi, auto_verdict: "admit", human_verdict: "admit", source: "review" },
      { lesson_id: lo, auto_verdict: "reject", human_verdict: "reject", source: "review" },
    ]);
    // 一条人推翻流水线的样本（不一致：分数高但被拒）。
    s.db.prepare(`INSERT INTO score_calibration (entity, lesson_id, entity_id, auto_verdict, human_verdict, score, at) VALUES ('lesson', ?, ?, 'admit', 'reject', 0.9, 1)`).run(hi, hi);
    const st = s.cal.stats(since);
    expect(st.latest).toMatchObject({ marked: 2, agreement: 1 });
    expect(st.latest.bands).toEqual([{ band: "high", marked: 1, good: 1 }, { band: "mid", marked: 0, good: 0 }, { band: "low", marked: 1, good: 0 }]);
    expect(st.all).toEqual({ agreement: 2 / 3, marked: 3, review: 2, override: 1 });
    expect(st.calibratedAt).toBeNull();
    s.cal.markCalibrated();
    expect(s.cal.stats(null).calibratedAt).toBe(new Date(s.clock.now).toISOString());
  });
});
