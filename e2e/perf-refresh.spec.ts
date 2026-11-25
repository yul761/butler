import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiagSnapshot, PerfWindow, Timing } from "../src/shared/diag";
import { completeWizard, expect, test } from "./fixtures";
import { REAL_SCALE, seedRefreshBench } from "./perf-seed";

/**
 * 刷新基准（BTL-265）：接近真实规模的数据下，一次刷新（now:view + 两次 turn:board，和渲染进程首页 + feature 页一样）
 * 主进程要多久，时间花在哪（导出诊断里 views.* / turn.input.* / now.* 的分段）。
 * 只在 SHIPHERD_PERF_BENCH=1 时跑；SHIPHERD_PERF_BUDGET_MS 给了就要求中位数在它以内，SHIPHERD_PERF_ROUNDS 是轮数（默认 15）。
 */
test.skip(process.env.SHIPHERD_PERF_BENCH !== "1", "set SHIPHERD_PERF_BENCH=1 to run the refresh benchmark");

const ROUNDS = Number(process.env.SHIPHERD_PERF_ROUNDS ?? 15);

type Bridge = { shipherd: { invoke(c: string, ...a: unknown[]): Promise<unknown> } };

const sumOps = (windows: PerfWindow[], key: "ops" | "invokes"): Record<string, Timing> => {
  const out: Record<string, Timing> = {};
  for (const w of windows) {
    for (const [name, t] of Object.entries(w[key])) {
      const o = (out[name] ??= { n: 0, totalMs: 0, maxMs: 0 });
      o.n += t.n;
      o.totalMs += t.totalMs;
      o.maxMs = Math.max(o.maxMs, t.maxMs);
    }
  }
  return out;
};

test("a refresh on real-scale data", async ({ makeSandbox, launch }, info) => {
  test.setTimeout(10 * 60_000);
  const s = makeSandbox();
  const first = await launch(s);
  await completeWizard(first.page, s);
  await first.app.close();
  const { featureIds } = seedRefreshBench(join(s.shipherdHome, "app.db"), s.dir, REAL_SCALE);

  const { page } = await launch(s);
  await expect(page.locator(".sidebar")).toBeVisible();
  // 启动时的一阵（迁移、扫描、第一次刷新）过去。
  await page.waitForTimeout(5000);
  const call = (channel: string, ...args: unknown[]) =>
    page.evaluate(async ([c, a]) => {
      const t0 = performance.now();
      const r = (await (window as unknown as Bridge).shipherd.invoke(c as string, ...(a as unknown[]))) as { ok: boolean; error?: unknown };
      if (!r.ok) throw new Error(`${c as string}: ${JSON.stringify(r.error)}`);
      return performance.now() - t0;
    }, [channel, args] as const);

  const startedAt = Date.now();
  const rounds: { now: number; board: number; featureBoard: number }[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    // 视图缓存最多留 1 秒：每一轮都是一次重新拼的刷新。
    await page.waitForTimeout(1100);
    const now = await call("now:view");
    const board = await call("turn:board", null);
    const featureBoard = await call("turn:board", { featureId: featureIds[0] });
    rounds.push({ now, board, featureBoard });
  }
  const snap = (await page.evaluate(async () => (await (window as unknown as Bridge).shipherd.invoke("diag:snapshot", false)) as { ok: boolean; value: DiagSnapshot })).value;
  const windows = [...snap.history, snap.current].filter((w) => w.end === 0 || w.end >= startedAt);
  const ops = sumOps(windows, "ops");
  const invokes = sumOps(windows, "invokes");
  const total = rounds.map((r) => r.now + r.board + r.featureBoard).sort((a, b) => a - b);
  const median = total[Math.floor(total.length / 2)];
  const fmt = (t: Timing) => `n=${t.n} avg=${(t.totalMs / t.n).toFixed(1)}ms max=${t.maxMs.toFixed(1)}ms`;
  const lines = [
    `refresh (now:view + 2× turn:board, renderer wall time): median ${median.toFixed(1)}ms, min ${total[0].toFixed(1)}ms, max ${total[total.length - 1].toFixed(1)}ms`,
    ...["now:view", "turn:board"].filter((c) => invokes[c]).map((c) => `ipc ${c}: ${fmt(invokes[c])}`),
    ...Object.entries(ops).filter(([name]) => /^(views|turn|now)\b/.test(name)).sort(([a], [b]) => a.localeCompare(b)).map(([name, t]) => `op ${name}: ${fmt(t)}`),
  ];
  console.log(lines.join("\n"));
  writeFileSync(info.outputPath("refresh-bench.txt"), lines.join("\n") + "\n");
  const budget = Number(process.env.SHIPHERD_PERF_BUDGET_MS ?? "");
  if (Number.isFinite(budget) && budget > 0) expect(median).toBeLessThan(budget);
});
