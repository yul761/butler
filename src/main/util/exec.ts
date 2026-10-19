import { execFile } from "node:child_process";

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type ExecText = (file: string, args: string[], opts?: ExecOptions) => Promise<string>;

/** Node 不允许不经 shell 直接执行 Windows 的 .cmd/.bat（npm 安装的 claude 就是 claude.cmd）。 */
export const execText: ExecText = (file, args, opts = {}) =>
  new Promise((done, fail) => {
    const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    execFile(
      viaShell ? `"${file}"` : file,
      args,
      { shell: viaShell, timeout: opts.timeoutMs ?? 10_000, env: opts.env, cwd: opts.cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) fail(new Error(`${file} ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`));
        else done(String(stdout));
      },
    );
  });
