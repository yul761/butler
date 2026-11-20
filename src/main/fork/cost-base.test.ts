import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { mkdirSync } from "node:fs";
import { cumulativeWeight, runCostFromCumulative } from "../../shared/run-cost";
import { DEV_BASE_MODEL_USAGE, F1, FORK_OPUS, T3 } from "../../shared/__fixtures__/cli-cost";
import { parseClaudeJson } from "../claude/headless";
import { costSinceBase, readCostBase, sameBase, transcriptCostBase } from "./cost-base";

/** 真 CLI（2.1.329）退出时写进 transcript 的那一行，只留了几个字段。modelUsage 的加权 token：100 输入 + 10 输出×5 = 150。 */
const costState = (total: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "cost-state", sessionId: "dev-1", totalCostUSD: total,
    modelUsage: { "claude-opus-5-5": { inputTokens: 100, outputTokens: 10, costUSD: total } }, hasUnknownModelCost: false, ...over,
  });
const user = (text: string) => JSON.stringify({ type: "user", sessionId: "dev-1", message: { role: "user", content: text } });

const write = (lines: string[]): string => {
  const file = join(tempDir(), "dev-1.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};
const read = (lines: string[]) => readCostBase(write(lines), "dev-1");

describe("readCostBase（开发 session transcript 里它最后一条 cost-state）", () => {
  it("takes the last cost-state line's totalCostUSD and modelUsage weight", async () => {
    expect(await read([user("hi"), costState(1.25), user("more"), costState(1.4674537), user("after")])).toEqual({ totalUsd: 1.4674537, weight: 150 });
  });
  it("no transcript: null", async () => {
    expect(await readCostBase(null, "dev-1")).toBeNull();
    expect(await readCostBase(join(tempDir(), "missing.jsonl"), "dev-1")).toBeNull();
  });
  it("no cost-state line: null", async () => {
    expect(await read([user("hi"), user("there")])).toBeNull();
  });
  it("a message that only mentions cost-state is not one (the line's own type decides)", async () => {
    expect(await read([costState(2), user('{"type":"cost-state","totalCostUSD":99}')])).toMatchObject({ totalUsd: 2 });
  });
  // CLI 按 sessionId 找自己的那一条。
  it("only the session's own lines count", async () => {
    expect(await read([costState(2), costState(7, { sessionId: "other" })])).toMatchObject({ totalUsd: 2 });
    expect(await read([costState(7, { sessionId: "other" })])).toBeNull();
  });
  it("the last cost-state is unusable: null, never an older one", async () => {
    expect(await read([costState(2), costState("3")])).toBeNull();
    expect(await read([costState(2), costState(-1)])).toBeNull();
    expect(await read([costState(2), JSON.stringify({ type: "cost-state", sessionId: "dev-1" })])).toBeNull();
    // 没有 modelUsage：CLI 的校验过不了，不会从它接着记。
    expect(await read([costState(2), costState(3, { modelUsage: undefined })])).toBeNull();
  });
  // 有模型 CLI 不会定价：减出来的 0 不是真的 0。
  it("hasUnknownModelCost: null", async () => {
    expect(await read([costState(2, { hasUnknownModelCost: true })])).toBeNull();
  });
  it("skips broken lines (a half-written last line, junk)", async () => {
    expect(await read([costState(0.5), "{not json", '{"type":"cost-st'])).toMatchObject({ totalUsd: 0.5 });
  });
  it("zero is a valid base (a session that hasn't spent anything yet)", async () => {
    expect(await read([costState(0, { modelUsage: {} })])).toEqual({ totalUsd: 0, weight: 0 });
  });
  it("CRLF line endings", async () => {
    const file = join(tempDir(), "dev-1.jsonl");
    writeFileSync(file, `${user("a")}\r\n${costState(0.75)}\r\n`);
    expect(await readCostBase(file, "dev-1")).toMatchObject({ totalUsd: 0.75 });
  });
});

describe("sameBase", () => {
  it("is the same line only when both were read and match", () => {
    expect(sameBase({ totalUsd: 1, weight: 2 }, { totalUsd: 1, weight: 2 })).toBe(true);
    expect(sameBase({ totalUsd: 1, weight: 2 }, { totalUsd: 1.5, weight: 3 })).toBe(false);
    expect(sameBase({ totalUsd: 1, weight: 2 }, null)).toBe(false);
  });
});

// BTL-239：分叉第一轮的准数 T1 − base，分叉讨论（turnCost）和 handoff / feature 汇总（runUsd）共用。
describe("costSinceBase", () => {
  const args = ["-p", "--resume", "dev-1", "--fork-session"];
  const fork = parseClaudeJson(JSON.stringify(FORK_OPUS), args)!;
  const base = { totalUsd: 4, weight: cumulativeWeight(DEV_BASE_MODEL_USAGE)! };

  it("is T1 − base, not the share split (the two differ on this fixture)", () => {
    const share = runCostFromCumulative(fork.costUsd, fork.usageRaw, fork.modelUsage, fork.model)!.usd;
    expect(costSinceBase(fork, base)).toBeCloseTo(0.3, 9);
    expect(Math.abs(share - 0.3)).toBeGreaterThan(0.02);
  });
  it("the real CLI's numbers: F1 − T3", () => {
    const f1 = parseClaudeJson(JSON.stringify(F1), args)!;
    expect(costSinceBase(f1, { totalUsd: T3.total_cost_usd, weight: cumulativeWeight(T3.modelUsage)! })).toBeCloseTo(F1.total_cost_usd - T3.total_cost_usd, 12);
  });
  it("no base or no total: null", () => {
    expect(costSinceBase(fork, null)).toBeNull();
    expect(costSinceBase({ ...fork, costUsd: null }, base)).toBeNull();
  });
  it("a base greater than T1: null", () => {
    expect(costSinceBase(fork, { ...base, totalUsd: 4.31 })).toBeNull();
  });
  it("the cumulative doesn't hold base + this run (the CLI restored less): null", () => {
    expect(costSinceBase(fork, { ...base, weight: base.weight * 1.1 })).toBeNull();
  });
  it("no modelUsage or usage to check against: null", () => {
    expect(costSinceBase({ ...fork, modelUsage: undefined }, base)).toBeNull();
    expect(costSinceBase({ ...fork, usageRaw: undefined }, base)).toBeNull();
  });
  // CLI 退回了更早的一条 cost-state，这一轮又有 subagent / compaction 把累计撑大：上面的核对过了，T1 − base 却少算（甚至成 0）。
  // 份额是约数（偏差在几成到几倍），比它的十分之一还少就不是偏差，是 base 不对。
  it("T1 − base far below the share estimate (a stale restored base): null", () => {
    expect(costSinceBase(fork, { ...base, totalUsd: 4.3 })).toBeNull();
    expect(costSinceBase(fork, { ...base, totalUsd: 4.29 })).toBeNull();
    expect(costSinceBase(fork, { ...base, totalUsd: 4.25 })).toBeCloseTo(0.05, 9);
  });
});

describe("transcriptCostBase（index 接的：按 session id 在 ~/.claude/projects 下找 transcript 再读）", () => {
  it("finds the session's transcript in any project dir and reads its base", async () => {
    const projects = tempDir();
    mkdirSync(join(projects, "-repo-a"));
    mkdirSync(join(projects, "-repo-b"));
    writeFileSync(join(projects, "-repo-b", "dev-1.jsonl"), `${user("hi")}\n${costState(1.5)}\n`);
    expect(await transcriptCostBase(projects, "dev-1")).toEqual({ totalUsd: 1.5, weight: 150 });
  });
  it("no transcript for that session: null", async () => {
    expect(await transcriptCostBase(tempDir(), "dev-1")).toBeNull();
    expect(await transcriptCostBase(join(tempDir(), "missing"), "dev-1")).toBeNull();
  });
});
