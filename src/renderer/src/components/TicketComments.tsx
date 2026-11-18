import { useState } from "react";
import { COMMENT_CATEGORIES, type CommentAction, type CommentCategory, type CommentItemView } from "../../../shared/loop";
import { api } from "../api";
import { reportError } from "../errors";
import { canCategorize, commentActions, commentSnippet, commentWhere } from "../loop-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

/** ticket 页「评论」标签（工作流 I）：每个 PR 的 review 评论、分类、状态，能送进 session、改分类、忽略、再回复。 */
export function TicketComments({ ticketKey }: { ticketKey: string }) {
  const prs = useStateRefetch(`loop-comments-${ticketKey}`, () => api.loopComments(ticketKey));
  const [note, setNote] = useState<string | null>(null);
  if (prs === null) return null;
  if (prs.length === 0) return <p className="empty">{S.lp.commentsNone}</p>;
  const act = (a: CommentAction) => {
    setNote(null);
    api.loopCommentsAct(a).then((r) => r === null && setNote(S.lp.actNone), reportError);
  };
  return (
    <div className="ticket-comments" data-testid="ticket-comments">
      {note && <p className="muted" role="status">{note}</p>}
      {prs.map((pr) => (
        <div key={pr.prId} data-testid={`comments-pr-${pr.number}`}>
          <h4 className="policy-group">{S.lp.pr(pr.number)}</h4>
          {!pr.enabled && <p className="muted">{S.lp.commentsOff}</p>}
          {pr.items.length === 0 ? <p className="empty">{S.lp.commentsNone}</p> : (
            <table className="policy-table">
              <tbody>
                {pr.items.map((c) => <CommentRow key={c.id} c={c} act={act} />)}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

function CommentRow({ c, act }: { c: CommentItemView; act: (a: CommentAction) => void }) {
  const label = { send: S.lp.send, dismiss: S.lp.dismiss, reply: S.lp.reply };
  const reason = c.reason === null ? null : (S.lp.reason[c.reason] ?? c.reason);
  return (
    <tr data-testid="comment-row" data-state={c.state}>
      <td>
        <span className="pill">{S.lp.who[c.who]}</span> <code>{commentWhere(c, S.lp.wholePr)}</code>
        <br />
        {c.url ? <a href={c.url} onClick={(e) => (e.preventDefault(), void api.prOpen(c.url!).catch(reportError))}>{commentSnippet(c.body)}</a> : commentSnippet(c.body)}
      </td>
      <td>
        {c.category === null ? <span className="muted">{S.lp.uncategorized}</span> : S.lp.category[c.category]}
        {c.source && <span className="muted"> · {S.lp.source[c.source]}</span>}
        {reason && <><br /><span className="muted">{reason}</span></>}
      </td>
      <td data-testid="comment-state">
        {S.lp.state[c.state]}
        {c.verified && <><br /><span className="muted">{S.lp.verified[c.verified]}</span></>}
        {c.repliedAt !== null && <><br /><span className="muted">{S.lp.replied}</span></>}
        {c.resolvedAt !== null && <><br /><span className="muted">{S.lp.resolved}</span></>}
        {c.replyError && <><br /><span className="error">{S.lp.replyError(c.replyError)}</span></>}
      </td>
      <td>
        <div className="actions">
          {commentActions(c).map((op) => <button key={op} data-testid={`comment-${op}`} onClick={() => act({ op, id: c.id })}>{label[op]}</button>)}
          {canCategorize(c) && (
            <select aria-label={S.lp.categorize} title={S.lp.categorize} value="" onChange={(e) => e.target.value && act({ op: "categorize", id: c.id, category: e.target.value as CommentCategory })}>
              <option value="">{S.lp.categorize}</option>
              {COMMENT_CATEGORIES.map((k) => <option key={k} value={k}>{S.lp.category[k]}</option>)}
            </select>
          )}
        </div>
      </td>
    </tr>
  );
}
