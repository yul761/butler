import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ID, shouldSetAppId } from "./app-id";

describe("APP_ID", () => {
  it("is only applied on Windows", () => {
    expect(shouldSetAppId("win32")).toBe(true);
    expect(shouldSetAppId("darwin")).toBe(false);
    expect(shouldSetAppId("linux")).toBe(false);
  });

  it("is the agreed reverse-DNS identity", () => {
    expect(APP_ID).toBe("io.statecore.butler");
  });

  // 计划 5 任务 7 之后 electron-builder.yml 一定存在：文件缺失或 appId 不同都算失败，不能悄悄跳过。
  it("matches the electron-builder appId", () => {
    const file = join(__dirname, "../../electron-builder.yml");
    expect(existsSync(file), `${file} is missing`).toBe(true);
    const m = /^appId:\s*["']?([^"'\s#]+)["']?/m.exec(readFileSync(file, "utf8"));
    expect(m?.[1]).toBe(APP_ID);
  });
});
