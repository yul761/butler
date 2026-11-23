import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// D-14：PR 进度格子和「已关闭」标签上的字，在它们实际的底色上对比度至少 4.5:1（WCAG AA）。
// 底色从 styles.css 里的规则读（color-mix 混的是 --ok / --accent / --danger 这些基础色，不是 --stage-*）。

const css = readFileSync(join(__dirname, "styles.css"), "utf8");

type Rgb = [number, number, number];
type Vars = Map<string, string>;

const varsOf = (block: string): Vars => new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

/** 第一个 :root 是浅色；@media (prefers-color-scheme: dark) 里的 :root 盖在它上面。 */
const light = varsOf(/^:root\s*\{([^}]*)\}/m.exec(css)![1]);
const dark = new Map([...light, ...varsOf(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)![1])]);

const hex = (v: string): Rgb => {
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) throw new Error(`not a #rrggbb colour: ${v}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb;
};

/** 支持 #rrggbb、var(--x) 和 color-mix(in srgb, A N%, B)。 */
function resolve(expr: string, vars: Vars): Rgb {
  const e = expr.trim();
  const v = /^var\((--[\w-]+)\)$/.exec(e);
  if (v) {
    const value = vars.get(v[1]);
    if (value === undefined) throw new Error(`undefined ${v[1]}`);
    return resolve(value, vars);
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(e);
  if (mix) {
    const [a, p, b] = [resolve(mix[1], vars), Number(mix[2]) / 100, resolve(mix[3], vars)];
    return a.map((c, i) => c * p + b[i] * (1 - p)) as Rgb;
  }
  return hex(e);
}

/** WCAG 2.x 相对亮度和对比度。 */
const luminance = (c: Rgb): number => {
  const [r, g, b] = c.map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const decl = (body: string, prop: string): string | null => new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;

/** 选择器里有 .pr-cell 或 .pr-closed、写了文字颜色的规则；没写底色的格子用 .pr-cell 本身的底色。 */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const base = rules.find((r) => r.selector === ".pr-cell")!;
const textRule = (r: { selector: string; body: string }) =>
  ({ selector: r.selector, color: decl(r.body, "color")!, background: decl(r.body, "background") ?? decl(base.body, "background")! });
const stageText = rules.filter((r) => /\.pr-(cell|closed)\b(?!-)/.test(r.selector) && decl(r.body, "color") !== null).map(textRule);
/** 「已合并」那种标签用的是现成的 .pill.merged，有自己的颜色，也一起查。 */
const checked = [...stageText, ...rules.filter((r) => r.selector === ".pill.merged").map(textRule)];
const stageTokens = [...light.keys()].filter((k) => k.startsWith("--stage-"));

describe("PR stage text contrast (D-14)", () => {
  it("finds the stage rules and tokens it checks", () => {
    expect(stageTokens.sort()).toEqual(["--stage-accent", "--stage-danger", "--stage-muted", "--stage-ok"]);
    expect(stageText.map((r) => r.selector)).toEqual(expect.arrayContaining([
      ".pr-cell", ".pr-cell.pr-done, .pr-cell.pr-feature_level", ".pr-cell.pr-active", ".pr-cell.pr-failed", ".pr-closed",
    ]));
    expect(checked.map((r) => r.selector)).toContain(".pill.merged");
  });

  it("stage text uses the --stage-* tokens", () => {
    for (const r of stageText) expect(r.color, r.selector).toMatch(/^var\(--stage-[\w-]+\)$/);
  });

  for (const [theme, vars] of [["light", light], ["dark", dark]] as const) {
    it(`${theme}: every stage text colour reaches 4.5:1 on its real background`, () => {
      for (const r of checked) {
        const ratio = contrast(resolve(r.color, vars), resolve(r.background, vars));
        expect(ratio, `${r.selector}: ${r.color} on ${r.background}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme}: every --stage-* token reaches 4.5:1 on --panel`, () => {
      for (const k of stageTokens) {
        expect(contrast(resolve(`var(${k})`, vars), resolve("var(--panel)", vars)), k).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

// UI 重做 §5.1：颜色只表示谁该动。每个 --turn-* 在面板和页面底色上都要到 4.5:1，
// 标签 .turn-tag.turn-<tone> 的字在它自己混出来的底色上也要到 4.5:1。
const TURN_TOKENS = ["--turn-agent", "--turn-ask", "--turn-shipherd", "--turn-done", "--turn-external", "--turn-idle", "--turn-merge", "--turn-stuck"];
const turnTags = rules.filter((r) => /^\.turn-tag\.turn-\w+$/.test(r.selector))
  .map((r) => ({ selector: r.selector, color: decl(r.body, "color")!, background: decl(r.body, "background")! }));

describe("turn colours (UI redesign §5.1)", () => {
  it("finds the turn tokens", () => {
    expect([...light.keys()].filter((k) => k.startsWith("--turn-")).sort()).toEqual(TURN_TOKENS);
    expect(turnTags).toHaveLength(8);
  });

  for (const [theme, vars] of [["light", light], ["dark", dark]] as const) {
    it(`${theme}: every --turn-* token reaches 4.5:1 on --panel and --bg`, () => {
      for (const k of TURN_TOKENS) {
        for (const bg of ["var(--panel)", "var(--bg)"]) {
          expect(contrast(resolve(`var(${k})`, vars), resolve(bg, vars)), `${k} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${theme}: every .turn-tag reaches 4.5:1 on its own background`, () => {
      expect(turnTags).toHaveLength(8);
      for (const r of turnTags) {
        expect(contrast(resolve(r.color, vars), resolve(r.background, vars)), r.selector).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

// 对话 tab 的黄框（UI 重做第 5 层）：标题字在黄框底色上、正文和灰字在黄框底色上、「讨论」标记在页面底色上，都要到 4.5:1。
describe("fork box colours (UI redesign layer 5)", () => {
  for (const [theme, vars] of [["light", light], ["dark", dark]] as const) {
    it(`${theme}: text in the fork box reaches 4.5:1`, () => {
      for (const [fg, bg] of [["--fork-head", "--fork-bg"], ["--text", "--fork-bg"], ["--muted", "--fork-bg"], ["--fork-head", "--bg"]]) {
        expect(contrast(resolve(`var(${fg})`, vars), resolve(`var(${bg})`, vars)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
