import { describe, expect, it } from "vitest";
import { failed, fakeRunner, setupAdmission } from "./__fixtures__/setup";
import { importConflictDetector } from "./import-conflicts";
import { OPEN_GATE, type StepCtx } from "./model-steps";

const rules = (p: string) => [...p.matchAll(/^#(-?\d+) \[[^\]]*\] \([^)]*\) (.*)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2] }));

describe("import conflict detector", () => {
  it("asks once per scope for pairs sharing a word, caches the answer and reports failures", async () => {
    const s = setupAdmission();
    let fail = false;
    const fake = fakeRunner({
      lesson_conflict: (req) => {
        if (fail) return failed();
        const rs = rules(req.prompt);
        const tabs = rs.find((r) => r.text.includes("tabs"));
        const spaces = rs.find((r) => r.text.includes("spaces"));
        return { conflicts: tabs && spaces ? [{ a: tabs.id, b: spaces.id, kind: "conflict", reason: "indent" }] : [] };
      },
    });
    const ctx: StepCtx = { run: fake.run, judgments: s.judgments, lang: () => "en", now: () => 1, cwd: "/", gate: OPEN_GATE };
    const detect = importConflictDetector(() => ctx, () => 30);
    const incoming = [
      { fingerprint: "f1", text: "indent with tabs", owner: { repo: "acme/web" } },
      { fingerprint: "f2", text: "name things well", owner: { repo: "acme/web" } },
      { fingerprint: "f3", text: "indent with tabs", owner: { repo: "acme/api" } },
    ];
    const local = [
      { id: 7, text: "indent with spaces", owner: { repo: "acme/web" } },
      { id: 8, text: "indent with spaces", owner: { product: "P" } },
    ];
    let failures = 0;
    expect(await detect(incoming, local, () => failures++)).toEqual([{ fingerprint: "f1", localId: 7, reason: "indent" }]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].prompt).not.toContain("name things well");
    expect(await detect(incoming, local, () => failures++)).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
    expect(failures).toBe(0);
    fail = true;
    expect(await detect([{ fingerprint: "f9", text: "indent with tabs always", owner: { repo: "acme/web" } }], local, () => failures++)).toEqual([]);
    expect(failures).toBe(1);
  });
});
