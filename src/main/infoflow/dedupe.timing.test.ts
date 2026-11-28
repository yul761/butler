import { describe, expect, it } from "vitest";
import { findDuplicate } from "./dedupe";
/*
 * dedupe 的计时（cf12cf39 复核建议 1）：zhPieces 以前每次都从当前位置重新找一对反义词的两头，「开启关闭」重复几万字是平方级
 * （20K/40K/80K 要 142/584/2273ms）。这里不卡绝对时间（几种形状本来就慢慢地线性增长），卡长度翻四倍时耗时的倍数：
 * 线性约 4 倍，平方级约 16 倍，上限 8 倍，两边各留一倍余量。每个输入先不计时跑一遍，再跑三次取最好的。
 */
const best = (f: () => void): number => {
  f();
  let b = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    f();
    b = Math.min(b, performance.now() - t);
  }
  return b;
};

describe("findDuplicate grows linearly with the length of the fact (BTL-272)", () => {
  const shapes: Record<string, string> = {
    zhPair: "开启关闭",
    zhPairs: "开启关闭打开关掉启用禁用",
    zhOneSide: "开启x",
    zhClauses: "开启x，",
    enPair: "on off ",
    enClauses: "turn on x. turn off y. ",
  };

  it.each(Object.entries(shapes))("%s repeated: 4× longer takes under 8× as long", (_, unit) => {
    const make = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
    const small = make(20_000);
    const large = make(80_000);
    const ts = best(() => findDuplicate(small, [small + "x"]));
    const tl = best(() => findDuplicate(large, [large + "x"]));
    expect(tl / Math.max(ts, 1)).toBeLessThan(8);
  });
});
