import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";

const root = fileURLToPath(new URL("../", import.meta.url));
let bundle = "";

// 只有支持 --build-sea 的 Node 才能跑 build:hook 的工具链检查；engines 允许更老的 Node，测试不应因此失败。
const nodeHasBuildSea = execFileSync(process.execPath, ["--help"], { encoding: "utf8" }).includes("--build-sea");

beforeAll(async () => {
  bundle = join(tempDir(), "hook.cjs");
  await build({ entryPoints: [join(root, "hook", "entry.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: bundle, logLevel: "silent" });
}, 60_000);

describe("butler-hook entry (design 4.3: never block Claude Code)", () => {
  it("writes the envelope and exits 0", () => {
    const home = tempDir();
    const r = spawnSync(process.execPath, [bundle], { input: '{"hook_event_name":"Stop","session_id":"s1"}', env: { ...process.env, BUTLER_HOME: home }, timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(readdirSync(join(home, "inbox")).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("exits 0 even when the inbox cannot be written (Review Focus 5)", () => {
    const home = tempDir();
    mkdirSync(join(home, "inbox"));
    chmodSync(join(home, "inbox"), 0o500);
    try {
      const r = spawnSync(process.execPath, [bundle], { input: "{}", env: { ...process.env, BUTLER_HOME: home }, timeout: 10_000 });
      expect(r.status).toBe(0);
    } finally {
      chmodSync(join(home, "inbox"), 0o700);
    }
  });

  it("exits 0 when BUTLER_HOME points at a file", () => {
    const home = join(tempDir(), "not-a-dir");
    writeFileSync(home, "x");
    const r = spawnSync(process.execPath, [bundle], { input: "{}", env: { ...process.env, BUTLER_HOME: home }, timeout: 10_000 });
    expect(r.status).toBe(0);
  });
});

describe("build:hook toolchain check", () => {
  it("pins a Node version in .node-version", () => {
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.skipIf(!nodeHasBuildSea)("accepts the running Node and exits early with --check-only", () => {
    const r = spawnSync(process.execPath, ["scripts/build-hook.mjs", "--check-only"], { cwd: root, encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
  });
});
