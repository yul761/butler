import { wakesTarget } from "../../shared/mailbox";

/** 判断要用到的消息字段：从哪个 session 来（Shipherd 自己发的是 null）、发给谁、什么类型、附带的 meta。 */
export interface QueuedMail {
  kind: string;
  fromSession: string | null;
  toSession: string;
  meta?: unknown;
}

/**
 * 这个 head 有没有别的 session 发来、还排着、该叫醒它的消息（关掉的 session 据此在后台恢复）。
 * Shipherd 自己发的（CI、预审、回答，fromSession 为 null）不算：那些等下次打开再看；约定广播、不重要的要点（wakesTarget 为 false）也不算。
 * headOf：把消息的收件 session 换成它现在的 head（接替过的按新 head 算）。
 */
export function hasSessionMail(queued: readonly QueuedMail[], headOf: (id: string) => string, headId: string): boolean {
  return queued.some((m) => m.fromSession !== null && wakesTarget(m) && headOf(m.toSession) === headId);
}

/**
 * 重启后恢复时排在最前面的那些 head：有排着、该叫醒它的消息的（wakesTarget：约定广播、不重要的要点不算）。
 * 这里只决定先后，Shipherd 自己发的通知也算（反正都会恢复，有新消息的先恢复）。
 */
export function headsWithWakingMail(queued: readonly QueuedMail[], headOf: (id: string) => string): Set<string> {
  return new Set(queued.flatMap((m) => (wakesTarget(m) ? [headOf(m.toSession)] : [])));
}
