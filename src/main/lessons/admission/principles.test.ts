import { describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import { fakeRunner, setupAdmission } from "./__fixtures__/setup";
import { OPEN_GATE } from "./model-steps";
import { AdmissionPipeline } from "./pipeline";
import { PrinciplesService } from "./principles";

const ids = (prompt: string) => [...prompt.matchAll(/^#(\d+) \[[^\]]*\] \([^)]*\) (.*)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2] }));

function build(answer: (rs: { id: number; text: string }[]) => unknown) {
  setLang("en");
  const s = setupAdmission();
  const fake = fakeRunner({ lesson_cluster: (req) => answer(ids(req.prompt)) });
  const pipeline = new AdmissionPipeline({
    repo: s.repo, recorder: s.recorder, policies: s.policies, judgments: s.judgments, runs: s.runs, checks: s.checks, drafter: { generate: async () => ({ ok: false }) as never }, run: fake.run,
    lang: () => "en", now: () => s.clock.now, fallbackCwd: () => "/home",
  });
  const svc = new PrinciplesService({
    db: s.db, repo: s.repo, recorder: s.recorder, pipeline, now: () => s.clock.now,
    ctx: () => ({ run: fake.run, judgments: s.judgments, lang: () => "en", now: () => s.clock.now, cwd: "/home", gate: OPEN_GATE }),
  });
  return { ...s, fake, svc };
}

describe("PrinciplesService", () => {
  it("groups confirmed lessons into principles in one undoable batch, reuses the cache", async () => {
    const s = build((rs) => ({ principles: [{ ids: rs.filter((r) => r.text.includes("error")).map((r) => r.id), text: "Never swallow errors", why: "bugs hide" }] }));
    const a = s.lesson("log the error before retrying", { status: "confirmed" });
    const b = s.lesson("do not ignore the error from fetch", { status: "confirmed" });
    const c = s.lesson("rethrow the error in the worker", { status: "confirmed" });
    const d = s.lesson("use tabs", { status: "confirmed" });
    s.lesson("pending error lesson");
    const r = await s.svc.regroup();
    expect(r).toMatchObject({ principles: 1, lessons: 3, failed: 0 });
    const pid = s.repo.get(a)!.principleId!;
    expect(pid).not.toBeNull();
    expect([b, c].map((x) => s.repo.get(x)!.principleId)).toEqual([pid, pid]);
    expect(s.repo.get(d)!.principleId).toBeNull();
    expect(s.repo.principleTexts([pid]).get(pid)).toEqual({ text: "Never swallow errors", why: "bugs hide" });

    // 规矩没变：不再调模型，也没有新批次。
    const again = await s.svc.regroup();
    expect(again.batchId).toBeNull();
    expect(s.fake.of("lesson_cluster")).toHaveLength(1);

    expect(s.recorder.undo(r.batchId!, 2).ok).toBe(true);
    expect(s.repo.get(a)!.principleId).toBeNull();
    expect(s.db.prepare(`SELECT COUNT(*) AS n FROM lesson_principles`).get()).toEqual({ n: 0 });
  });

  it("drops a principle that lost its group and keeps a layer whose call failed", async () => {
    let mode: "group" | "none" | "fail" = "group";
    const s = build((rs) => (mode === "fail" ? { nope: 1 } : { principles: mode === "group" ? [{ ids: rs.map((r) => r.id), text: "P", why: "w" }] : [] }));
    const xs = [1, 2, 3].map((i) => s.lesson(`rule ${i}`, { status: "confirmed" }));
    await s.svc.regroup();
    const pid = s.repo.get(xs[0])!.principleId;
    expect(pid).not.toBeNull();
    s.lesson("rule 4", { status: "confirmed" });
    mode = "fail";
    expect(await s.svc.regroup()).toMatchObject({ failed: 1 });
    expect(s.repo.get(xs[0])!.principleId).toBe(pid);
    mode = "none";
    s.lesson("rule 5", { status: "confirmed" });
    await s.svc.regroup();
    expect(xs.map((x) => s.repo.get(x)!.principleId)).toEqual([null, null, null]);
    expect(s.db.prepare(`SELECT COUNT(*) AS n FROM lesson_principles`).get()).toEqual({ n: 0 });
  });

  it("a regroup does not block undoing an earlier lesson batch, and undoing that batch keeps the grouping", async () => {
    const s = build((rs) => ({ principles: [{ ids: rs.map((r) => r.id), text: "P", why: "w" }] }));
    const xs = [1, 2, 3].map((i) => s.lesson(`rule ${i}`));
    const confirm = s.batches.bulk("confirm", { ids: xs });
    const r = await s.svc.regroup();
    const pid = s.repo.get(xs[0])!.principleId;
    expect(pid).not.toBeNull();
    expect(s.recorder.undo(confirm.batchId!, 5)).toMatchObject({ ok: true, outcome: { skipped: 0 } });
    expect(xs.map((x) => s.repo.get(x)!.status)).toEqual(["pending", "pending", "pending"]);
    expect(xs.map((x) => s.repo.get(x)!.principleId)).toEqual([pid, pid, pid]);
    // 分组那一批也还能撤（原则删掉，规矩不再指着它）。
    expect(s.recorder.undo(r.batchId!, 6)).toMatchObject({ ok: true, outcome: { skipped: 0 } });
    expect(xs.map((x) => s.repo.get(x)!.principleId)).toEqual([null, null, null]);
  });
});
