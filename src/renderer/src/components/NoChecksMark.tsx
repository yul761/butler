import type { CheckAbsenceReason } from "../../../shared/checks";
import { S } from "../strings";

/** session 启动时没挂上检查（契约 4.5 第 7 点）：一个小标记，提示里说为什么。 */
export function NoChecksMark({ reason }: { reason: CheckAbsenceReason | null | undefined }) {
  if (!reason) return null;
  return (
    <span className="pill pending session-no-checks" data-testid="session-no-checks" title={S.sessionNoChecksTitle[reason]}>
      {S.sessionNoChecks}
    </span>
  );
}
