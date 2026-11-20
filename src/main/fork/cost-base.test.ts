import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { readCostBase } from "./cost-base";

/** 真 CLI（2.1.329）退出时写进 transcript 的那一行，只留了几个字段。 */
const costState = (total: unknown) =>
  JSON.stringify({ type: "cost-state", sessionId: "dev-1", totalCostUSD: total, modelUsage: { "claude-opus-5-5": { inputTokens: 1, costUSD: total } }, hasUnknownModelCost: false });
const user = (text: string) => JSON.stringify({ type: "user", sessionId: "dev-1", message: { role: "user", content: text } });

const write = (lines: string[]): string => {
  const file = join(tempDir(), "dev-1.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};

describe("readCostBase（开发 session transcript 里最后一条 cost-state 的 totalCostUSD）", () => {
  it("takes the last cost-state line's totalCostUSD", async () => {
    expect(await readCostBase(write([user("hi"), costState(1.25), user("more"), costState(1.4674537), user("after")]))).toBe(1.4674537);
  });
  it("no transcript: null", async () => {
    expect(await readCostBase(null)).toBeNull();
    expect(await readCostBase(join(tempDir(), "missing.jsonl"))).toBeNull();
  });
  it("no cost-state line: null", async () => {
    expect(await readCostBase(write([user("hi"), user("there")]))).toBeNull();
  });
  it("a message that only mentions cost-state is not one (the line's own type decides)", async () => {
    expect(await readCostBase(write([costState(2), user('{"type":"cost-state","totalCostUSD":99}')]))).toBe(2);
  });
  it("the last cost-state has no usable totalCostUSD: null, never an older one", async () => {
    expect(await readCostBase(write([costState(2), costState("3")]))).toBeNull();
    expect(await readCostBase(write([costState(2), costState(-1)]))).toBeNull();
    expect(await readCostBase(write([costState(2), JSON.stringify({ type: "cost-state" })]))).toBeNull();
  });
  it("skips broken lines (a half-written last line, junk)", async () => {
    expect(await readCostBase(write([costState(0.5), "{not json", '{"type":"cost-st']))).toBe(0.5);
  });
  it("zero is a valid base (a session that hasn't spent anything yet)", async () => {
    expect(await readCostBase(write([costState(0)]))).toBe(0);
  });
  it("CRLF line endings", async () => {
    const file = join(tempDir(), "dev-1.jsonl");
    writeFileSync(file, `${user("a")}\r\n${costState(0.75)}\r\n`);
    expect(await readCostBase(file)).toBe(0.75);
  });
});
