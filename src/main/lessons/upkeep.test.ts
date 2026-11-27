import { describe, expect, it } from "vitest";
import { LessonUpkeep, UPKEEP_DAILY_MS, UPKEEP_TIGHT_MS, type UpkeepDeps } from "./upkeep";

const MIN = 60_000;

function build(o: { tight?: boolean; principles?: boolean } = {}) {
  const at = { regroup: 0, merge: 0 };
  const n = { tight: 0, regroup: 0, suggest: 0 };
  let tight = o.tight ?? false;
  const d: UpkeepDeps = {
    gateOpen: () => true,
    tight: () => (n.tight++, tight),
    principlesOn: () => o.principles ?? false,
    lastAt: (j) => at[j],
    setLastAt: (j, v) => (at[j] = v),
    regroup: async () => void n.regroup++,
    mergeRunning: () => false,
    suggest: async () => void n.suggest++,
    log: () => {},
  };
  return { up: new LessonUpkeep(d), n, at, setTight: (v: boolean) => (tight = v) };
}

describe("LessonUpkeep", () => {
  it("principles off and everything fits: the budget is checked at most once an hour, not every minute", () => {
    const s = build();
    const t0 = UPKEEP_DAILY_MS * 2;
    for (let m = 0; m < 60; m++) s.up.tick(t0 + m * MIN);
    expect(s.n.tight).toBe(1);
    expect(s.n.regroup).toBe(0);
    expect(s.n.suggest).toBe(1); // 找相似规矩每天一次
    s.up.tick(t0 + 61 * MIN);
    expect(s.n.tight).toBe(2);
    expect(s.n.suggest).toBe(1);
  });

  it("when a repo does not fit, both jobs run hourly regardless of the principles setting", () => {
    const s = build({ tight: true });
    const t0 = UPKEEP_DAILY_MS * 2;
    s.up.tick(t0);
    expect(s.n).toMatchObject({ regroup: 1, suggest: 1 });
    s.up.tick(t0 + 30 * MIN);
    expect(s.n).toMatchObject({ regroup: 1, suggest: 1 });
    s.up.tick(t0 + UPKEEP_TIGHT_MS + MIN);
    expect(s.n).toMatchObject({ regroup: 2, suggest: 2 });
  });

  it("does nothing, not even the budget check, while nothing is due", () => {
    const s = build({ tight: true });
    s.at.regroup = 1_000;
    s.at.merge = 1_000;
    s.up.tick(1_000 + 10 * MIN);
    expect(s.n).toEqual({ tight: 0, regroup: 0, suggest: 0 });
  });
});
