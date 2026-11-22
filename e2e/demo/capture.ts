import type { Locator, Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 演示动图的录制（BTL-251）：不用视频录制，而是在要拍的几段里连续截图，每帧记下时间，最后用 ffmpeg 按真实间隔拼成 GIF。
 * 两段之间（等 PR watcher、切页面）不截图，GIF 里就没有这段等待。
 */

/** 每帧至少隔多久（毫秒）：GIF 最多 10 帧/秒。 */
const FRAME_MS = 100;
/** 一帧最长显示多久：截图卡顿时不让画面停太久。 */
const MAX_FRAME_MS = 600;

export interface Frame {
  file: string;
  /** 这一帧显示多久（毫秒）。 */
  ms: number;
}

/** 帧间隔 → 每帧显示多久：最后一帧显示 lastMs，太长的间隔截成 MAX_FRAME_MS（hold 写进去的除外）。 */
export function frameDurations(stamps: number[], holds: Map<number, number>, lastMs: number): number[] {
  return stamps.map((t, i) => holds.get(i) ?? (i + 1 < stamps.length ? Math.min(stamps[i + 1] - t, MAX_FRAME_MS) : lastMs));
}

/** ffmpeg concat 清单：每帧一行 file 加一行 duration；最后一帧要再写一次，不然它的 duration 不算。 */
export function concatList(frames: Frame[]): string {
  const lines = frames.flatMap((f) => [`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${(f.ms / 1000).toFixed(3)}`]);
  if (frames.length > 0) lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  return `${lines.join("\n")}\n`;
}

export class Recorder {
  private readonly stamps: number[] = [];
  private readonly holds = new Map<number, number>();
  private running: Promise<void> | null = null;
  private stop = false;

  constructor(private readonly page: Page, private readonly dir: string) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  private async shoot(): Promise<void> {
    const n = this.stamps.length;
    this.stamps.push(Date.now());
    await this.page.screenshot({ path: this.file(n), scale: "css", animations: "allow" });
  }

  private file(n: number): string {
    return join(this.dir, `f${String(n).padStart(5, "0")}.png`);
  }

  /** 开始连续截图（已经在截就什么都不做）。 */
  resume(): void {
    if (this.running) return;
    this.stop = false;
    this.running = (async () => {
      while (!this.stop) {
        const t = Date.now();
        await this.shoot();
        const left = FRAME_MS - (Date.now() - t);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
      }
    })();
  }

  /** 停下连续截图；停下前补一帧，这一段最后的画面在 GIF 里停 ms 毫秒。 */
  async pause(ms = 300): Promise<void> {
    if (!this.running) return;
    this.stop = true;
    await this.running;
    this.running = null;
    await this.shoot();
    this.holds.set(this.stamps.length - 1, ms);
  }

  /** 在截图的同时等一会儿。 */
  async hold(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  frames(lastMs = 2000): Frame[] {
    const ms = frameDurations(this.stamps, this.holds, lastMs);
    return this.stamps.map((_, i) => ({ file: this.file(i), ms: ms[i] }));
  }

  /** 用 ffmpeg 拼成 GIF：先按帧时长拼、统一到 10 帧/秒、缩到 width 宽，再生成调色板，只重画变了的矩形。 */
  encode(out: string, width = 1280): void {
    const list = join(this.dir, "frames.txt");
    writeFileSync(list, concatList(this.frames()));
    const filter = `fps=10,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-filter_complex", filter, "-loop", "0", out], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.error?.message ?? r.stderr}`);
  }
}

/** ffmpeg 在不在：录制前先查，缺了直接说清楚。 */
export function assertFfmpeg(): void {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("demo:record needs ffmpeg on PATH (macOS: brew install ffmpeg). See docs/demo-media.md.");
}

/**
 * 页面里加三样只给录制用的东西：底部的字幕条、一个假鼠标（截图里没有真鼠标）、把沙盒的临时目录换成 ~ 显示
 * （演示里的仓库都放在沙盒 HOME 下的 code/ 里，页头显示成 ~/code/...，不露出 /var/folders/... 这种临时路径）。
 */
export async function installOverlay(page: Page, home: string): Promise<void> {
  await page.evaluate((home) => {
    const style = document.createElement("style");
    style.textContent = `
      #demo-caption { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 99999; pointer-events: none;
        background: rgba(20, 22, 28, 0.88); color: #fff; font: 600 20px/1.3 -apple-system, "PingFang SC", "Segoe UI", sans-serif;
        padding: 10px 22px; border-radius: 999px; box-shadow: 0 6px 24px rgba(0,0,0,.18); opacity: 0; transition: opacity .25s; white-space: nowrap; }
      #demo-caption.on { opacity: 1; }
      #demo-cursor { position: fixed; left: 0; top: 0; z-index: 100000; pointer-events: none; width: 22px; height: 22px; transition: transform .45s ease-in-out; opacity: 0; }
      #demo-cursor.on { opacity: 1; }
      #demo-cursor.press::after { content: ""; position: absolute; left: -9px; top: -9px; width: 22px; height: 22px; border-radius: 50%; background: rgba(66, 120, 255, .35); }`;
    document.head.appendChild(style);
    const caption = document.createElement("div");
    caption.id = "demo-caption";
    document.body.appendChild(caption);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10 13 L16 13 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(cursor);
    const fix = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue?.includes(home)) node.nodeValue = node.nodeValue.split(home).join("~");
        return;
      }
      if (node instanceof Element && node.id !== "demo-caption") node.childNodes.forEach(fix);
    };
    fix(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") fix(r.target);
        r.addedNodes.forEach(fix);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, home);
}

export async function caption(page: Page, text: string | null): Promise<void> {
  await page.evaluate((text) => {
    const el = document.getElementById("demo-caption")!;
    if (text === null) {
      el.classList.remove("on");
      return;
    }
    el.textContent = text;
    el.classList.add("on");
  }, text);
}

/** 假鼠标移到 target 中间（带动画），再点它。 */
export async function demoClick(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(([x, y]) => {
    const c = document.getElementById("demo-cursor")!;
    c.classList.add("on");
    c.style.transform = `translate(${x}px, ${y}px)`;
  }, [x, y]);
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById("demo-cursor")!.classList.add("press"));
  await page.waitForTimeout(150);
  await target.click();
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("demo-cursor")!.classList.remove("press"));
}

/** 截静态图之前把字幕和假鼠标藏起来。 */
export async function hideOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("demo-caption")!.classList.remove("on");
    document.getElementById("demo-cursor")!.classList.remove("on");
  });
  await page.waitForTimeout(300);
}
