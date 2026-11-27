import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiagSnapshot, PerfWindow, Timing } from "../src/shared/diag";
import { completeWizard, expect, test } from "./fixtures";
import { REAL_SCALE, seedRefreshBench } from "./perf-seed";

/**
 * 空闲基准（BTL-275）：接近真实规模的数据、没有在干活的 session，放着不动一段时间，主进程推给界面多少次 state:changed、
 * 界面因此重取了多少次（invoke）、主进程和界面各用了多少 CPU。先窗口开着量一段，再把窗口藏起来（关窗口 = 藏到托盘）量一段，
 * 最后把窗口叫回来，看藏着时攒下的变化有没有补发。
 * 只在 SHIPHERD_PERF_BENCH=1 时跑；SHIPHERD_PERF_IDLE_MS 是每段多长（默认 125 秒，盖住两次每分钟的 tick）。
 */
test.skip(process.env.SHIPHERD_PERF_BENCH !== "1", "set SHIPHERD_PERF_BENCH=1 to run the idle benchmark");

const PHASE_MS = Number(process.env.SHIPHERD_PERF_IDLE_MS ?? 125_000);

type Bridge = { shipherd: { invoke(c: string, ...a: unknown[]): Promise<unknown> } };

const sumOps = (windows: PerfWindow[]): Record<string, Timing> => {
  const out: Record<string, Timing> = {};
  for (const w of windows) {
    for (const [name, t] of Object.entries(w.ops)) {
      const o = (out[name] ??= { n: 0, totalMs: 0, maxMs: 0 });
      o.n += t.n;
      o.totalMs += t.totalMs;
    }
  }
  return out;
};

test("an idle app with real-scale data", async ({ makeSandbox, launch }, info) => {
  test.setTimeout(3 * PHASE_MS + 5 * 60_000);
  const s = makeSandbox();
  const first = await launch(s);
  await completeWizard(first.page, s);
  await first.app.close();
  seedRefreshBench(join(s.shipherdHome, "app.db"), s.dir, REAL_SCALE);

  const { app, page } = await launch(s);
  await expect(page.locator(".sidebar")).toBeVisible();
  // 启动时的一阵（迁移、扫描、第一次刷新）过去。
  await page.waitForTimeout(8000);
  const snapshot = async (reset: boolean): Promise<DiagSnapshot> =>
    (await page.evaluate(async (r) => (await (window as unknown as Bridge).shipherd.invoke("diag:snapshot", r)) as { ok: boolean; value: DiagSnapshot }, reset)).value;
  const ops = async (): Promise<Record<string, Timing>> => {
    const snap = await snapshot(false);
    return sumOps([...snap.history, snap.current]);
  };
  const lines: string[] = [];
  const phase = async (name: string): Promise<DiagSnapshot["measure"]> => {
    const before = await ops();
    await snapshot(true);
    await page.waitForTimeout(PHASE_MS);
    const m = (await snapshot(true)).measure;
    const after = await ops();
    const perMin = (n: number) => ((n * 60_000) / m.sinceMs).toFixed(1);
    const sends = Object.entries(m.sends).sort(([a], [b]) => a.localeCompare(b)).map(([c, v]) => `${c}=${v.n}`).join(" ");
    const opDelta = Object.entries(after)
      .map(([k, t]) => [k, t.n - (before[k]?.n ?? 0), t.totalMs - (before[k]?.totalMs ?? 0)] as const)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n, ms]) => `${k}=${n}/${ms.toFixed(0)}ms`)
      .join(" ");
    const cpu = Object.entries(m.cpuSec).map(([k, v]) => `${k}=${v.toFixed(2)}s`).join(" ");
    lines.push(
      `[${name}] ${(m.sinceMs / 1000).toFixed(0)}s: state:changed ${m.sends["state:changed"]?.n ?? 0} (${perMin(m.sends["state:changed"]?.n ?? 0)}/min), ` +
        `invokes ${m.invokes.n} (${perMin(m.invokes.n)}/min, ${m.invokes.totalMs.toFixed(0)}ms in handlers)`,
      `[${name}] sends: ${sends || "(none)"}`,
      `[${name}] cpu: ${cpu}`,
      `[${name}] ops: ${opDelta || "(none)"}`,
    );
    return m;
  };

  await phase("visible");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  const hidden = await phase("hidden");
  // 叫回来：藏着的时候攒下的变化要补发一次 state:changed。
  await snapshot(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.showInactive());
  await page.waitForTimeout(2000);
  const back = (await snapshot(true)).measure;
  lines.push(`[shown again] within 2s: state:changed ${back.sends["state:changed"]?.n ?? 0}, invokes ${back.invokes.n}`);
  console.log(lines.join("\n"));
  writeFileSync(info.outputPath("idle-bench.txt"), lines.join("\n") + "\n");
  expect(hidden.sinceMs).toBeGreaterThan(0);
});
