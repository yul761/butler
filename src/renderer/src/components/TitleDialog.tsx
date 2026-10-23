import { useState, type FormEvent } from "react";
import type { Ticket } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";

/** 改 ticket 的标题（清空就是没有标题）。 */
export function TitleDialog({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const [title, setTitle] = useState(ticket.title ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.updateTicket({ key: ticket.key, title });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{S.editTicket(ticket.key)}</h2>
        <label>{S.titleShort}<input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>{S.cancel}</button>
          <button type="submit" className="primary">{S.save}</button>
        </div>
      </form>
    </div>
  );
}
