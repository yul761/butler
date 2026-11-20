// 对话 tab 里的黄框（UI 重做第 5 层）：一次分叉讨论的问答、模式和费用、失败原因，加上「按这个改」「记进记忆」「接着问」。
// 只吃 props：取数据、调 IPC 都在 ConversationTab 里，这里只有「接着问」那个小输入框自己的草稿。
import { useState } from "react";
import type { ForkView } from "../../../shared/fork";
import { resetClock } from "../availability-view";
import { costText, draftCheck, errorText, lastQuestion, modeText } from "../conversation-view";
import { S } from "../strings";

export interface ForkActions {
  followUp(forkId: number, q: string): void;
  sendConclusion(forkId: number): void;
  remember(forkId: number): void;
  reaskFull(forkId: number): void;
  retry(forkId: number): void;
  /** 每个框正在做的那件事（做完清掉）；有值时这个框的按钮都不能点。 */
  pending: Record<number, "ask" | "send" | "remember" | "reask" | undefined>;
  /** 每个框最近一次操作的结果或被挡下的原因。 */
  notice: Record<number, string | undefined>;
  /** 记忆开着（设置里的开关，且这个范围能记）；关着时「记进记忆」不能点。 */
  memoryOn: boolean;
}

export function ForkBox({ fork, actions, now }: { fork: ForkView; actions: ForkActions; now: number }) {
  const [asking, setAsking] = useState(false);
  const [q, setQ] = useState("");
  const id = fork.id;
  const pending = actions.pending[id];
  const busy = pending !== undefined;
  const locked = fork.status === "running" || busy;
  // 命令行没分叉出新对话：这个讨论不能再接着问（「再问一次」会重新开一个）。
  const dead = fork.error?.code === "not_forked";
  const draft = draftCheck("fork", q);
  const notice = actions.notice[id];

  function ask() {
    actions.followUp(id, q.trim());
    setQ("");
    setAsking(false);
  }

  return (
    <div className={`fork ${fork.status}`}>
      <div className="h">{S.conv.forkHead}</div>
      <div className="conv-mode muted">{modeText(fork.mode, S)} · {costText(fork, S)}</div>
      {fork.messages.map((m) =>
        m.role === "user"
          ? <div key={m.id} className="msg-u">{S.conv.you}{m.text}</div>
          : <div key={m.id} className="msg-a">{m.text}</div>,
      )}
      {fork.error && <p className="error">{errorText(fork.error, S, now)}</p>}
      {fork.summarySentAt !== null && <p className="muted fork-sent">{S.conv.sentAt(resetClock(fork.summarySentAt, now))}</p>}
      {notice && <p className="fork-notice">{notice}</p>}
      <div className="acts">
        <button disabled={locked || dead} onClick={() => actions.sendConclusion(id)}>{pending === "send" ? S.conv.sending : S.conv.actSend}</button>
        <button disabled={locked || dead || !actions.memoryOn} title={actions.memoryOn ? undefined : S.conv.memoryOff} onClick={() => actions.remember(id)}>
          {S.conv.actRemember}
        </button>
        <button disabled={locked || dead} aria-expanded={asking} onClick={() => setAsking(!asking)}>{S.conv.actFollowUp}</button>
        {fork.mode === "light" && <button disabled={busy} onClick={() => actions.reaskFull(id)}>{S.conv.actReaskFull}</button>}
        {fork.status === "failed" && lastQuestion(fork) !== null && <button disabled={busy} onClick={() => actions.retry(id)}>{S.conv.actRetry}</button>}
      </div>
      {asking && !dead && (
        <div className="fork-ask">
          <textarea rows={2} value={q} placeholder={S.conv.askPlaceholder} onChange={(e) => setQ(e.target.value)} />
          <button className="primary" disabled={locked || draft.blank || draft.over} onClick={ask}>{S.conv.send}</button>
          {draft.over && <p className="error">{S.conv.tooLong(draft.max)}</p>}
        </div>
      )}
    </div>
  );
}
