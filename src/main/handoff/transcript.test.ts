import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { findHandoffBlock, readLastTurn } from "./transcript";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (uuid: string, content: unknown) => ({ type: "assistant", uuid, message: { role: "assistant", content } });
const text = (t: string) => [{ type: "text", text: t }];
const BLOCK = '```butler-handoff\n{"ticket":"PROJ-1"}\n```';

/** 验证记录 V4 的形状：更早的一轮，然后“命令消息 + isMeta 的展开文本”，然后这一轮的 assistant 条目。 */
function writeTurn(file: string, entries: unknown[]) {
  writeFileSync(
    file,
    [
      line(user("更早的问题")),
      line(assistant("old", text('```butler-handoff\n{"ticket":"OLD"}\n```'))),
      line(user("<command-message>handoff</command-message>\n<command-name>/handoff</command-name>")),
      line(user(text("请生成 handoff……示例：\n```butler-handoff\n{}\n```"), { isMeta: true })),
      ...entries.map(line),
    ].join(""),
  );
}

describe("readLastTurn / findHandoffBlock", () => {
  it("finds the block in the last turn, not in the command text or older turns", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeTurn(file, [assistant("a1", text(`好的：\n${BLOCK}`))]);
    const turn = await readLastTurn(file);
    expect(turn).toEqual([{ uuid: "a1", text: `好的：\n${BLOCK}` }]);
    expect(findHandoffBlock(turn)).toEqual({ uuid: "a1", block: '{"ticket":"PROJ-1"}' });
  });

  it("looks past tool calls inside the turn and takes the last block", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeTurn(file, [
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr view" } }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "PR #9 open" }]),
      assistant("a2", text(BLOCK.replace("PROJ-1", "DRAFT"))),
      assistant("a3", text(BLOCK)),
    ]);
    expect(findHandoffBlock(await readLastTurn(file))).toEqual({ uuid: "a3", block: '{"ticket":"PROJ-1"}' });
  });

  it("returns nothing when the last turn has no block", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeTurn(file, [assistant("a1", text("没有代码块"))]);
    expect(findHandoffBlock(await readLastTurn(file))).toBeNull();
  });

  it("only reads the tail of a large transcript and skips the cut-off first line", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeFileSync(file, "");
    const filler = line(user("x".repeat(10_000)));
    for (let i = 0; i < 300; i++) appendFileSync(file, filler);
    appendFileSync(file, line(user("/handoff")) + line(assistant("a9", text(BLOCK))));
    expect(findHandoffBlock(await readLastTurn(file, 64 * 1024))).toEqual({ uuid: "a9", block: '{"ticket":"PROJ-1"}' });
  });

  it("skips corrupt lines", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeFileSync(file, line(user("q")) + "{not json\n" + line(assistant("a1", text(BLOCK))) + "null\n");
    expect(findHandoffBlock(await readLastTurn(file))?.uuid).toBe("a1");
  });
});
