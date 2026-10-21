/**
 * 只给测试用的工具（不会被生产代码 import，所以不会打进主进程包）。
 * 放在 gateway 目录里：后面的假服务器要用 node:http，只有这里允许。
 */
import type { Rng } from "./types";

/** 可复现的随机数（mulberry32）。 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
