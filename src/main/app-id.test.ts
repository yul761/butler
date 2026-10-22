import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ID } from "./app-id";

describe("APP_ID", () => {
  it("is the agreed reverse-DNS identity", () => {
    expect(APP_ID).toBe("io.github.yul761.butler");
  });

  it("matches the electron-builder appId once electron-builder.yml exists (Task 7)", () => {
    const file = join(__dirname, "../../electron-builder.yml");
    if (!existsSync(file)) return;
    const m = /^appId:\s*["']?([^"'\s#]+)["']?/m.exec(readFileSync(file, "utf8"));
    expect(m?.[1]).toBe(APP_ID);
  });
});
