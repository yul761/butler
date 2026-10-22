import { execFile } from "node:child_process";

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type ExecText = (file: string, args: string[], opts?: ExecOptions) => Promise<string>;

/** Arguments that are safe to pass unquoted through cmd.exe. */
export const SAFE_SHELL_ARG = /^[A-Za-z0-9_\-.=:/@,+]+$/;

/** A Windows .cmd/.bat file (npm/pnpm shims): it only runs through cmd.exe. Re-exported by claude/launch.ts. */
export function isCmdShim(file: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/** Decides how to spawn: whether to go through cmd.exe, the quoted command, and any argument unsafe for the shell. */
export function shellPlan(
  file: string,
  args: string[],
  platform: NodeJS.Platform,
): { viaShell: boolean; command: string; unsafeArg: string | null } {
  // Constant arguments only (health checks): a shim goes through cmd.exe here, unlike the session launch in claude/launch.ts.
  const viaShell = isCmdShim(file, platform);
  const command = viaShell ? `"${file}"` : file;
  const unsafeArg = viaShell ? (args.find((a) => !SAFE_SHELL_ARG.test(a)) ?? null) : null;
  return { viaShell, command, unsafeArg };
}

/** Only for trusted constant arguments; free text (prompts) must never go through argv. */
export const execText: ExecText = (file, args, opts = {}) =>
  new Promise((done, fail) => {
    const plan = shellPlan(file, args, process.platform);
    if (plan.unsafeArg !== null) {
      fail(new Error(`unsafe argument for shell execution: ${plan.unsafeArg}`));
      return;
    }
    execFile(
      plan.command,
      args,
      { shell: plan.viaShell, timeout: opts.timeoutMs ?? 10_000, env: opts.env, cwd: opts.cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) fail(new Error(`${file} ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`));
        else done(String(stdout));
      },
    );
  });
