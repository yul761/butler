import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { readCostBase, sameBase } from "./cost-base";

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
