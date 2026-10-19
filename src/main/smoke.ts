import { DatabaseSync } from "node:sqlite";
import * as pty from "node-pty";

// 验证 Electron 内置 Node 能用 node:sqlite，且 node-pty 原生模块能加载并启动进程。
export async function runSmoke(): Promise<number> {
  const db = new DatabaseSync(":memory:");
  const row = db.prepare("SELECT 1 AS one").get() as { one: number };
  console.log(`sqlite-ok ${row.one}`);
  db.close();

  const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "echo pty-ok"]] : ["/bin/echo", ["pty-ok"]];
  const output = await new Promise<string>((resolve) => {
    let buf = "";
    const p = pty.spawn(file, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
    p.onData((d) => (buf += d));
    p.onExit(() => resolve(buf));
  });
  const ok = output.includes("pty-ok");
  console.log(ok ? "pty-ok" : `pty-fail ${JSON.stringify(output)}`);
  return ok ? 0 : 1;
}
