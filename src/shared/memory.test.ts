import { describe, expect, it } from "vitest";
import { NOTE_BODY_LIMIT, NOTE_ID_LIMIT, noteBody, noteId, noteText, parseNote, sameBody, ticketScope } from "./memory";

describe("Butler memory note format", () => {
  it("writes and parses the stable prefix", () => {
    expect(noteText({ kind: "decision", id: "db", body: "用 PostgreSQL" })).toBe("[decision:db] 用 PostgreSQL");
    expect(parseNote("[decision:db] 用 PostgreSQL")).toEqual({ kind: "decision", id: "db", variant: 1, body: "用 PostgreSQL" });
    expect(parseNote("[decision:a:b] x")).toEqual({ kind: "decision", id: "a:b", variant: 1, body: "x" });
    expect(parseNote("[followup:f_1#3] 改配置")).toEqual({ kind: "followup", id: "f_1", variant: 3, body: "改配置" });
  });

  it("gives every variant a deterministic run of distinguishing words, longer for later variants", () => {
    const v2 = noteText({ kind: "followup", id: "f_1", body: "改配置" }, 2);
    const v3 = noteText({ kind: "followup", id: "f_1", body: "改配置" }, 3);
    expect(v2).toMatch(/^\[followup:f_1#2( [a-z]{4}){3}\] 改配置$/);
    expect(v3).toMatch(/^\[followup:f_1#3( [a-z]{4}){6}\] 改配置$/);
    expect(noteText({ kind: "followup", id: "f_1", body: "改配置" }, 2)).toBe(v2);
    expect(noteText({ kind: "followup", id: "f_2", body: "改配置" }, 2)).not.toBe(v2);
    expect(parseNote(v3)).toEqual({ kind: "followup", id: "f_1", variant: 3, body: "改配置" });
  });

  it("does not take other notes for Butler's", () => {
    for (const t of ["用户喜欢 tabs", "[learning:PROJ-1] 经验", "[decision:] 空 id", "[decision:x]没有空格", "[note:x] 别的前缀", " [decision:x] 前面有空格", "[decision:x#2 ABCD] 大写的区分词"]) {
      expect(parseNote(t), t).toBeNull();
    }
  });

  it("sanitizes ids and truncates bodies (Review Focus 5)", () => {
    expect(noteId("cache ttl]#\nv2")).toBe("cache-ttl-v2");
    expect(noteId("  ")).toBe("_");
    expect(noteId("Ｄｂ")).toBe("Db");
    expect(noteId("x".repeat(100))).toHaveLength(NOTE_ID_LIMIT);
    expect(noteBody("  第一行\n第二行\t\t结束  ")).toBe("第一行 第二行 结束");
    expect(Array.from(noteBody("长".repeat(600)))).toHaveLength(NOTE_BODY_LIMIT);
    // 不把代理对从中间切开。
    const emoji = noteBody("😀".repeat(500));
    expect(Array.from(emoji)).toHaveLength(NOTE_BODY_LIMIT);
    expect(emoji.endsWith("😀")).toBe(true);
    const text = noteText({ kind: "decision", id: noteId("k]ey"), body: noteBody("a\nb") });
    expect(parseNote(text)).toMatchObject({ id: "k-ey", body: "a b" });
    // 最坏情况（最长的 id、最长的正文、第 5 个变体）也在 StateCore 的 500 字上限之内。
    const worst = noteText({ kind: "followup", id: noteId("i".repeat(100)), body: noteBody("长".repeat(1000)) }, 5);
    expect(Array.from(worst).length).toBeLessThanOrEqual(500);
  });

  it("compares bodies the way StateCore dedupes (case, width and spacing insensitive)", () => {
    expect(sameBody(" Use  PostgreSQL ", "use postgresql")).toBe(true);
    expect(sameBody("ＡＢＣ", "abc")).toBe(true);
    expect(sameBody("v1", "v2")).toBe(false);
  });

  it("names ticket scopes", () => {
    expect(ticketScope("PROJ-12")).toBe("ticket:PROJ-12");
  });
});
