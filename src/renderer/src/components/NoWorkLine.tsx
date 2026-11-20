// 一件工作都还没有时首页只显示这一句加三个新建按钮（UI 重做第 2 层的过渡；第 6 层的首次使用首页接手后删掉）。
import { S } from "../strings";

export function NoWorkLine({ onNewTicket, onNewFeature, onNewEpic }: { onNewTicket: () => void; onNewFeature: () => void; onNewEpic: () => void }) {
  return (
    <div className="no-work" data-testid="no-work">
      <p>{S.hm.noWork}</p>
      <div className="actions">
        <button className="primary" onClick={onNewTicket}>+ {S.newTicket}</button>
        <button onClick={onNewFeature}>+ {S.newFeature}</button>
        <button onClick={onNewEpic}>+ {S.newEpic}</button>
      </div>
    </div>
  );
}
