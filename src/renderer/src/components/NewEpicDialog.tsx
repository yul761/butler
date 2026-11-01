import { api } from "../api";
import { S } from "../strings";
import { epicErrorText } from "./epic-row";
import { WorkspaceDialog } from "./NewFeatureDialog";

/** 新建 epic（设计文档 2026-11-01）：和新建 feature 同样的对话框。 */
export function NewEpicDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  return (
    <WorkspaceDialog
      title={S.newEpic} nameLabel={S.epicName} namePlaceholder="checkout-revamp" workspaceHint={S.epicWorkspaceDefault}
      create={(input) => api.createEpic(input).then((e) => e.id)}
      errorText={(e) => epicErrorText(e, S)}
      onClose={onClose} onCreated={onCreated}
    />
  );
}
