import { afterEach, describe, expect, it } from "vitest";
import { S, setUiLang } from "../strings";
import { formatDuration } from "./TicketActivity";

const MIN = 60_000;

afterEach(() => setUiLang("zh"));

describe("formatDuration", () => {
  it("shows minutes and hours", () => {
    expect(formatDuration(18 * MIN, S)).toBe("18 分钟");
    expect(formatDuration(60 * MIN, S)).toBe("1 小时");
    expect(formatDuration(125 * MIN, S)).toBe("2 小时 5 分钟");
    expect(formatDuration(10_000, S)).toBe("刚刚");
  });

  it("works in English", () => {
    setUiLang("en");
    expect(formatDuration(18 * MIN, S)).toBe("18 min");
    expect(formatDuration(65 * MIN, S)).toBe("1 hour 5 min");
  });
});
