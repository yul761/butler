import { useState } from "react";
import type { Lesson } from "../../../shared/lessons";
import { scorePartRows } from "../admission-view";
import { formatScore } from "../lessons-bulk-view";
import { S } from "../strings";

/** 规矩的评分分项：默认收起，点开看每一项的值和理由、用的哪一版策略。 */
export function ScoreParts({ lesson }: { lesson: Lesson }) {
  const [open, setOpen] = useState(false);
  const rows = scorePartRows(lesson.scoreParts);
  if (!rows.length) return null;
  return (
    <div className="lesson-score">
      <button className="link" aria-expanded={open} data-testid={`lesson-score-toggle-${lesson.id}`} onClick={() => setOpen(!open)}>
        {open ? S.lessonScoreHide : S.lessonScoreParts}
      </button>
      {open && (
        <ul className="lesson-score-parts" data-testid={`lesson-score-parts-${lesson.id}`}>
          {rows.map(({ key, part }) => (
            <li key={key} data-testid={`lesson-score-part-${lesson.id}-${key}`}>
              <strong>{S.scorePartLabel[key]}</strong> {formatScore(part.value)}
              {part.reason && <span className="muted"> · {part.reason}</span>}
            </li>
          ))}
          {lesson.scorePolicyVersion !== null && <li className="muted" data-testid={`lesson-score-policy-${lesson.id}`}>{S.lessonScorePolicy(lesson.scorePolicyVersion)}</li>}
        </ul>
      )}
    </div>
  );
}
