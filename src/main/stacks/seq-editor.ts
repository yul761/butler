import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `git rebase -i --update-refs` 的 sequence editor（设计 3.2 节）：todo 里只留 Butler 临时分支的 `update-ref` 行，
 * 其他分支（真的层分支、用户自己的分支）不让 git 改；其余的行原样保留。
 * 用 node 跑（Electron 里是 process.execPath + ELECTRON_RUN_AS_NODE=1，和 MCP 服务一样），两个平台都行。
 */
const SCRIPT = `const fs = require("fs");
const file = process.argv[process.argv.length - 1];
const keep = "update-ref " + process.env.BUTLER_STACK_KEEP;
const text = fs.readFileSync(file, "utf8");
const eol = text.includes("\\r\\n") ? "\\r\\n" : "\\n";
const out = text.split(/\\r?\\n/).filter((l) => !l.startsWith("update-ref ") || l.startsWith(keep));
fs.writeFileSync(file, out.join(eol));
`;

/** git 用 sh 跑 editor 命令（Windows 上是 Git 自带的 sh）：路径换成正斜杠、加引号。 */
export function shQuote(p: string): string {
  return `"${p.replace(/\\/g, "/").replace(/(["$`\\])/g, "\\$1")}"`;
}

/** 写脚本到 dir，返回给 rebase 用的环境变量。keepPrefix 是临时分支的完整前缀（refs/heads/butler-stack/<runId>/）。 */
export function sequenceEditorEnv(dir: string, execPath: string, keepPrefix: string): Record<string, string> {
  const script = join(dir, "butler-seq-editor.cjs");
  writeFileSync(script, SCRIPT);
  return {
    GIT_SEQUENCE_EDITOR: `${shQuote(execPath)} ${shQuote(script)}`,
    ELECTRON_RUN_AS_NODE: "1",
    BUTLER_STACK_KEEP: keepPrefix,
    // 冲突后 rebase --continue 不要开编辑器
    GIT_EDITOR: "true",
  };
}
