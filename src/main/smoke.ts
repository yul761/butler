import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import { withScope } from "./memory/statecore";

// 验证 Electron 内置 Node 能用 node:sqlite，且 node-pty 原生模块能加载并启动进程。
export async function runSmoke(): Promise<number> {
  try {
    const db = new DatabaseSync(":memory:");
    const row = db.prepare("SELECT 1 AS one").get() as { one: number };
    console.log(`sqlite-ok ${row.one}`);
    db.close();

    // StateCore 的嵌入式存储（node:sqlite + statecore-mcp/lib）能在 Electron 主进程里写、读。
    const scDir = mkdtempSync(join(tmpdir(), "butler-smoke-"));
    try {
      const n = await withScope({ dataDir: scDir, scope: "smoke" }, async (s) => {
        await s.remember("smoke note");
        return (await s.facts()).length;
      });
      console.log(`statecore-ok ${n}`);
    } finally {
      rmSync(scDir, { recursive: true, force: true });
    }

    const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "echo pty-ok"]] : ["/bin/echo", ["pty-ok"]];
    const output = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("pty timeout after 10s")), 10_000);
      try {
        const p = pty.spawn(file, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
        p.onData((d) => (buf += d));
        p.onExit(() => {
          clearTimeout(timer);
          resolve(buf);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    const ok = output.includes("pty-ok");
    console.log(ok ? "pty-ok" : `pty-fail ${JSON.stringify(output)}`);
    return ok ? 0 : 1;
  } catch (err) {
    console.log(`smoke-fail ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
