import { execFile } from "node:child_process";

export interface PrInfo {
  number: number;
  url: string;
  head: string;
  base: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  autoMerge: boolean;
}

/** gh pr view [pr]：pr 为 null 时看 cwd 当前分支的 PR。gh 没装、没登录、超时、输出不对都返回 null，从不抛错。 */
export function prInfo(cwd: string, pr: string | null, timeoutMs: number): Promise<PrInfo | null> {
  return new Promise((done) => {
    const args = ["pr", "view", ...(pr === null ? [] : [pr]), "--json", "number,url,headRefName,baseRefName,state,autoMergeRequest"];
    execFile("gh", args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return done(null);
      try {
        const j = JSON.parse(String(stdout)) as Record<string, unknown>;
        if (typeof j.number !== "number" || typeof j.url !== "string" || typeof j.headRefName !== "string" || typeof j.baseRefName !== "string") return done(null);
        if (j.state !== "OPEN" && j.state !== "MERGED" && j.state !== "CLOSED") return done(null);
        done({ number: j.number, url: j.url, head: j.headRefName, base: j.baseRefName, state: j.state, autoMerge: j.autoMergeRequest !== null && j.autoMergeRequest !== undefined });
      } catch {
        done(null);
      }
    });
  });
}
