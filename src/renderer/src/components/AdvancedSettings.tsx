import { useEffect, useRef, useState, type ComponentType } from "react";
import { ADVANCED_GROUPS, type AdvancedGroupId } from "../../../shared/settings-layout";
import { S } from "../strings";
import { CostBackgroundSettings } from "./CostBackgroundSettings";
import { ExternalActionSettings } from "./ExternalActionSettings";
import { IntakeSettings } from "./IntakeSettings";
import { InterruptSettings } from "./InterruptSettings";
import { LessonsSettings } from "./LessonsSettings";
import { LoopSettings } from "./LoopSettings";
import { ReviewSettings } from "./ReviewSettings";
import { RoutingSettings } from "./RoutingSettings";
import { ScheduleSettings } from "./ScheduleSettings";
import { SessionPerfSettings } from "./SessionPerfSettings";
import { StackSettings } from "./StacksPanel";
import { useCollapsed } from "./useCollapsed";

const GROUP_BODY: Record<AdvancedGroupId, ComponentType> = {
  schedule: ScheduleSettings,
  sessions: SessionPerfSettings,
  routing: RoutingSettings,
  cost: CostBackgroundSettings,
  loop: LoopSettings,
  review: ReviewSettings,
  stacks: StackSettings,
  intake: IntakeSettings,
  interrupts: InterruptSettings,
  lessons: LessonsSettings,
  external: ExternalActionSettings,
};

/**
 * 一个分组：默认收起，收起时只画头部，展开才挂载里面的组件（免得进页面就发十几个读设置的请求）。
 * forced：从别处的链接跳过来要看这一组，先展开，但不写进「记住展开」；用户再点就照常收起。
 */
function AdvancedGroup({ id, forced }: { id: AdvancedGroupId; forced: boolean }) {
  const [collapsed, toggle] = useCollapsed(`settings-adv:${id}`, true);
  const [forcedOpen, setForcedOpen] = useState(forced);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setForcedOpen(forced);
    if (forced) ref.current?.scrollIntoView?.({ block: "start" });
  }, [forced]);
  const open = forcedOpen || !collapsed;
  const onClick = () => {
    if (!forcedOpen) return toggle();
    setForcedOpen(false);
    if (!collapsed) toggle();
  };
  const Body = GROUP_BODY[id];
  return (
    <div className="adv-group" ref={ref}>
      <button
        type="button"
        className="adv-group-head"
        data-testid={`adv-group-${id}`}
        aria-expanded={open}
        aria-controls={`adv-body-${id}`}
        onClick={onClick}
      >
        <span className="adv-group-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        {S.set.groups[id]}
      </button>
      {open && (
        <div className="adv-group-body" id={`adv-body-${id}`} data-testid={`adv-body-${id}`}>
          <Body />
        </div>
      )}
    </div>
  );
}

/** 设置 › 高级：原来各组的细项，按 ADVANCED_GROUPS 的顺序，默认收起。 */
export function AdvancedSettings({ openGroup }: { openGroup: AdvancedGroupId | null }) {
  return (
    <section className="settings-section adv-groups">
      <p className="muted">{S.set.advancedIntro}</p>
      {ADVANCED_GROUPS.map((id) => (
        <AdvancedGroup key={id} id={id} forced={openGroup === id} />
      ))}
    </section>
  );
}
