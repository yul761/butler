// 信箱（BTL-245）的磁盘投影：主进程和 shipherd-hook 共用的约定。
// <mailbox>/<SHIPHERD_SESSION>/<queuedAt>-<id>.json 是一条在排队的消息；目录不在就是信箱为空，hook 不启动 shipherd-hook。

/** hook 认领了、还没写出去：`<name>.taken-<pid>`。 */
export const TAKEN_SUFFIX = ".taken-";
/** hook 写出去了：主进程看到就记成送达（via hook），然后删掉。 */
export const DONE_SUFFIX = ".done";
/** 主进程认领了，正在直接输入。 */
export const MAIN_SUFFIX = ".main";
export const MSG_SUFFIX = ".json";

/** 一次 additionalContext 最多这么多字符（Claude Code 的上限是 10,000，超了只给模型看前 2,000）。 */
export const MAILBOX_CONTEXT_LIMIT = 9000;

/** 一条消息的文件内容。intro 是只有一条 / 有几条时的开头（{n} 换成条数），主进程按当时的语言写。 */
export interface MailboxFile {
  id: string;
  text: string;
  intro: string;
  /** 写这份文件时正文的版本（主进程用；hook 不看）。按 ref 换了正文以后，hook 送的还是旧的那份，就不算送到新的。 */
  rev?: string;
}

/** hook 送完以后写进 hook 收件箱的信封里的 hook_event_name：主进程收到就去清扫这个终端的 .done。 */
export const MAILBOX_EVENT = "ShipherdMailbox";

export const messageFileName = (queuedAt: number, id: string): string => `${String(queuedAt).padStart(15, "0")}-${id}${MSG_SUFFIX}`;

/** 文件名（任何后缀）里的消息 id；认不出为 null。 */
export function messageIdOf(name: string): string | null {
  const m = /^\d+-([0-9A-Za-z-]+)\.json(?:\.taken-\d+|\.done|\.main)?$/.exec(name);
  return m ? m[1] : null;
}

/** sh 的双引号里要转义的字符。 */
const dq = (s: string): string => s.replace(/[\\"$`]/g, (c) => `\\${c}`);

/**
 * PostToolUse 的信箱 hook 命令（macOS 的 sh、Windows 的 Git Bash 都能跑）：目录不在就只是一次 test，退出 0；在才 exec shipherd-hook。
 * hook 是 hookCommand 生成的带引号的路径；dir 是信箱根目录（Windows 上换成正斜杠）。没有 SHIPHERD_SESSION 的（外部终端）看的是 `_`，不存在。
 */
export function mailboxHookCommand(hook: string, dir: string, platform: NodeJS.Platform): string {
  const d = dq(platform === "win32" ? dir.replace(/\\/g, "/") : dir);
  return `[ ! -d "${d}/\${SHIPHERD_SESSION:-_}" ] || exec ${hook} mailbox "${d}"`;
}

/**
 * 排着这条消息时要不要叫醒目标（休眠着的叫醒；总控开的、真关了的在后台恢复）。约定广播不叫；信息流转的要点（fact，BTL-272）
 * 只有重要的（meta.wake 为 true）才叫，其余排着等下次打开。
 */
export function wakesTarget(m: { kind: string; meta?: unknown }): boolean {
  if (m.kind === "convention") return false;
  if (m.kind === "fact") return !!m.meta && typeof m.meta === "object" && (m.meta as { wake?: unknown }).wake === true;
  return true;
}
