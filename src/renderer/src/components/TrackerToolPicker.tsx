import { useState } from "react";
import type { McpProbe } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { probeIncomplete } from "../settings-form";
import { S } from "../strings";

/** 从 Claude Code 的配置里只读检测 MCP 工具，勾选后交给 onSave（设置页和首次启动向导共用）。 */
export function TrackerToolPicker({ onSave }: { onSave: (picked: string[]) => Promise<void> }) {
  const [probe, setProbe] = useState<McpProbe | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);

  async function detect() {
    setDetecting(true);
    try {
      const p = await api.detectTrackerTools();
      setProbe(p);
      setPicked(p.suggested);
    } catch (e) {
      reportError(e);
    } finally {
      setDetecting(false);
    }
  }

  const togglePick = (t: string) => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t]);

  return (
    <>
      <div className="actions">
        <button disabled={detecting} onClick={() => void detect()}>{detecting ? S.detecting : S.detectTools}</button>
      </div>
      {probe && probeIncomplete(probe) && <p className="muted">{S.probeIncomplete}</p>}
      {probe && probe.tools.length === 0 && <p className="muted">{S.noDetectedTools}</p>}
      {probe && probe.tools.length > 0 && (
        <div className="probe">
          <p className="muted">{S.detectedTools(probe.tools.length, probe.suggested.length)}</p>
          {probe.tools.map((t) => (
            <label key={t} className="inline">
              <input type="checkbox" checked={picked.includes(t)} onChange={() => togglePick(t)} />
              <code>{t}</code>
            </label>
          ))}
          <div className="actions">
            <button className="primary" disabled={picked.length === 0} onClick={() => void onSave(picked)}>{S.addSelected}</button>
          </div>
        </div>
      )}
    </>
  );
}
