import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// BTL-279 第四轮复核建议 1：index.ts 里巡检那一轮、补查回复、恢复全局总控、启动失败对话框的接线。
// 判断本身抽成了纯函数（PatrolTurns.messageDelivered、wakeStateFor、startupErrorText），各自有单测；这里守着 index.ts 真的把它们接上。
const root = fileURLToPath(new URL("../../", import.meta.url));
const indexSource = readFileSync(join(root, "src", "main", "index.ts"), "utf8");

/** index.ts 里从 start 开始到 close 为止的那一段。 */
function block(start: string, close: string): string {
  const from = indexSource.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(indexSource.indexOf(start, from + 1), `${start} appears once`).toBe(-1);
  const end = indexSource.indexOf(close, from + start.length);
  expect(end, start).toBeGreaterThan(from);
  return indexSource.slice(from, end);
}

describe("index.ts mailbox and patrol wiring (BTL-279 fourth review)", () => {
  it("one PatrolTurns, fed by the mailbox's delivered callback with the delivered message itself", () => {
    expect(indexSource.match(/new PatrolTurns\(/g)).toHaveLength(1);
    const mailbox = block("const mailbox = new Mailbox({", "\n  });");
    const delivered = mailbox.slice(mailbox.indexOf("    delivered: (m) => {"));
    expect(delivered).toMatch(/^ {4}delivered: \(m\) => \{\n {6}patrolTurns\.messageDelivered\(sessions\.head\(m\.toSession\)\?\.id \?\? m\.toSession, m\);\n {6}resumer\?\.delivered\(m\);\n {4}\},/);
    // 送到的消息只经这一处开巡检那一轮：不直接调 delivered(headId, at)，那样会绕过「只认直接输入」。
    expect(indexSource).not.toMatch(/patrolTurns\.delivered\(/);
  });

  it("the mailbox checks a closed turn through the activity monitor's transcript", () => {
    expect(block("const mailbox = new Mailbox({", "\n  });")).toContain("    turnClosed: (id) => activityMonitor.turnClosed(id),\n");
  });

  it("a Stop ends that head's patrol turn, at the top of sessionStopped", () => {
    const stopped = block("const sessionStopped = (stopped: string): void => {", "\n  };");
    expect(stopped).toMatch(/^const sessionStopped = \(stopped: string\): void => \{\n {4}holdWatcher\.sessionIdle\(stopped\);\n {4}patrolTurns\.stopped\(sessions\.head\(stopped\)\?\.id \?\? stopped\);\n/);
  });

  it("a terminal exiting, and a session being hidden, forget that head's patrol records", () => {
    const exit = block("    exit: (id, code) => {", "\n    },");
    expect(exit).toContain("      patrolTurns.forget(sessions.head(id)?.id ?? id);\n");
    // 退出 Shipherd 时（closing）不管：那时这些内存都不要了。
    expect(exit.indexOf("patrolTurns.forget")).toBeGreaterThan(exit.indexOf("if (closing) return;"));
    const hidden = block("    hidden: (id) => {", "\n    },");
    expect(hidden).toMatch(/\n {6}patrolTurns\.forget\(sessions\.head\(id\)\?\.id \?\? id\);$/);
    expect(hidden).toContain("hibernator?.forget(id);");
  });

  it("list_sessions' wake goes through wakeStateFor with the delivery's controller check and the caller's patrol turn", () => {
    const wake = block("      wakeState: (id, caller) => {", "\n      },");
    expect(wake).toContain("return wakeStateFor(id, caller, {");
    expect(wake).toContain("hibernated: isHibernated,");
    expect(wake).toContain("controls: mailboxControls,");
    expect(wake).toContain("patrolling: (c) => patrolTurns.active(sessions.head(c)?.id ?? c),");
    expect(wake).toMatch(/const r = resumer;[\s\S]*status: r \? \(x, o\) => r\.status\(x, o\) : null,/);
    // 全局总控的只读数据（send_message 打巡检标记）也看同一个 PatrolTurns。
    expect(block("      shipherd: {", "\n      },")).toContain("        patrolling: (id) => patrolTurns.active(id),\n");
  });

  it("resuming knows which global controller is the one to keep", () => {
    expect(block("const resumableCtx = {", "\n  };")).toMatch(/\n {4}latestShipherd: \(\) => sessionService\.latestShipherd\(\)\?\.id \?\? null,$/);
  });

  it("the startup failure dialog shows startupErrorText, after the declined-backup branch", () => {
    const fail = indexSource.slice(indexSource.lastIndexOf("    .then(bootstrap)"));
    expect(fail).toMatch(/\.catch\(\(e: unknown\) => \{[\s\S]*if \(e instanceof DatabaseBackupError && e\.declined\) \{[\s\S]*return;\n {6}\}[\s\S]*dialog\.showErrorBox\(M\(\)\.startupFailed, startupErrorText\(e\)\);\n {6}app\.exit\(1\);/);
    expect(indexSource.match(/startupErrorText\(/g)).toHaveLength(1);
  });
});

describe("index.ts mail-wakes-a-session wiring (BTL-272 rebase review suggestion 1)", () => {
  it("the background restore asks wake.ts's hasSessionMail with the queued messages and the head mapping", () => {
    expect(indexSource).toContain('import { hasSessionMail as sessionMailWakes, headsWithWakingMail } from "./mailbox/wake";');
    expect(indexSource).toContain("  const headOf = (id: string): string => sessions.head(id)?.id ?? id;\n");
    expect(indexSource).toContain("  const hasSessionMail = (headId: string): boolean => sessionMailWakes(messagesRepo.queued(), headOf, headId);\n");
    expect(indexSource).toMatch(/resumer && hasSessionMail\(id\)\) void resumer\.request\(id, "mail"\)/);
  });

  it("the restart order puts first the heads from wake.ts's headsWithWakingMail", () => {
    const restart = block('if (settings.get("autoResumeAfterRestart") === "1"', "\n  }\n");
    expect(restart).toContain("const mail = headsWithWakingMail(messagesRepo.queued(), (id) => sessions.head(id)?.id ?? id);");
    expect(restart).toContain("restartOrder(heads, (id) => mail.has(id),");
  });

  it("index.ts makes no wake decision of its own from a message's kind", () => {
    expect(indexSource).not.toMatch(/wakesTarget/);
    // 引号、等号、空格怎么写都算（复核 c067e822 建议 4：只认 m.kind !== "convention" 的话，换成单引号就绕过了）。
    expect(indexSource).not.toMatch(/kind\s*[!=]==?\s*["'`]convention["'`]/);
    expect(indexSource).not.toMatch(/["'`]convention["'`]\s*[!=]==?\s*\w*\.?kind/);
  });
});
