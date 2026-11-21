import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import type { DiagSnapshot } from "../src/shared/diag";
import { completeWizard, expect, makeGitRepo, ROOT, terminalText, test, newButton, openTicketTab, type Sandbox } from "./fixtures";

/**
 * 性能场景（BTL-242）：3 个 session 在干活（假 claude 的 /fake-work：每 300ms 一次工具调用、约 2KB 终端输出），
 * 停在首页 30 秒、再停在一个 ticket 页（终端开着）30 秒，记下事件循环 p99、state:changed 次数和界面 long task 总时长。
 * 只在 BUTLER_E2E_PERF=1 时跑（要两分多钟，数字写进 test-results/perf/perf-<label>.json）。
 */
test.skip(process.env.BUTLER_E2E_PERF !== "1", "perf scenario runs only with BUTLER_E2E_PERF=1");

const MEASURE_MS = 30_000;
const KEYS = ["PERF-1", "PERF-2", "PERF-3"];

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function makeFeature(page: Page, s: Sandbox): Promise<void> {
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await (await newButton(page, "newFeature")).click();
  await page.getByLabel(S.featureName, { exact: true }).fill("checkout");
  const dir = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
  await dir.fill(shop);
  await dir.blur();
  await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  for (const [n, key] of KEYS.entries()) {
    if (n > 0) await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
    await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
    await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
    await page.locator(".modal").getByRole("checkbox", { name: "frontend", exact: true }).check();
    await page.locator(".modal").getByRole("checkbox", { name: "backend", exact: true }).uncheck();
    await page.getByRole("button", { name: S.create, exact: true }).click();
    await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
  }
}

const ticketPage = (page: Page, key: string) => page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: key }).click();

async function startWork(page: Page, key: string): Promise<void> {
  await ticketPage(page, key);
  await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "/fake-work 150 300");
  await expect.poll(() => terminalText(page)).toContain("work 1.");
}

interface Measured {
  seconds: number;
  eldP50: number | null;
  eldP99: number | null;
  eldMax: number | null;
  stateChanged: number;
  turnChanged: number;
  ptyDataKb: number;
  longTasks: number;
  longTaskMs: number;
  invokes: number;
  invokeMs: number;
  cpuSec: Record<string, number>;
}

/** 量 MEASURE_MS：主进程那边用 diag:snapshot 的测量段，渲染进程这边自己挂一个 long task 观察器。 */
async function measure(page: Page): Promise<Measured> {
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { n: number; ms: number; obs: PerformanceObserver } };
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__perf.n += 1;
        w.__perf.ms += e.duration;
      }
    });
    w.__perf = { n: 0, ms: 0, obs };
    obs.observe({ type: "longtask", buffered: false });
  });
  await page.evaluate(() => (window as unknown as { butler: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }).butler.invoke("diag:snapshot", true));
  await page.waitForTimeout(MEASURE_MS);
  const snap = (await page.evaluate(() => (window as unknown as { butler: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }).butler.invoke("diag:snapshot", false))) as { ok: true; value: DiagSnapshot };
  const lt = await page.evaluate(() => {
    const w = window as unknown as { __perf: { n: number; ms: number; obs: PerformanceObserver } };
    w.__perf.obs.disconnect();
    return { n: w.__perf.n, ms: w.__perf.ms };
  });
  const m = snap.value.measure;
  return {
    seconds: Math.round(m.sinceMs / 100) / 10,
    eldP50: m.eld?.p50 ?? null,
    eldP99: m.eld?.p99 ?? null,
    eldMax: m.eld?.max ?? null,
    stateChanged: m.sends["state:changed"]?.n ?? 0,
    turnChanged: m.sends["turn:changed"]?.n ?? 0,
    ptyDataKb: Math.round((m.sends["pty:data"]?.bytes ?? 0) / 1024),
    longTasks: lt.n,
    longTaskMs: Math.round(lt.ms),
    invokes: m.invokes.n,
    invokeMs: m.invokes.totalMs,
    cpuSec: m.cpuSec,
  };
}

test("perf: three working sessions on the home page and a ticket page", async ({ makeSandbox, launch }) => {
  test.setTimeout(300_000);
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await makeFeature(page, s);
  for (const key of KEYS) await startWork(page, key);

  await page.locator(".sidebar").getByRole("button", { name: S.home, exact: true }).click();
  await page.waitForTimeout(2_000);
  const home = await measure(page);

  await ticketPage(page, KEYS[0]);
  await openTicketTab(page, "terminal");
  await page.waitForTimeout(2_000);
  const ticket = await measure(page);

  const label = process.env.BUTLER_E2E_PERF_LABEL ?? "run";
  const result = { label, platform: process.platform, home, ticket };
  const dir = join(ROOT, "test-results", "perf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `perf-${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`perf ${JSON.stringify(result)}`);
  expect(home.seconds).toBeGreaterThan(25);
});
