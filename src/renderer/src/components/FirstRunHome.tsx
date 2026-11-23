import type { ReactElement } from "react";
import { S } from "../strings";

/** 第 2 层（首页）渲染它、接三个回调；组件不判断有没有工作，不认识路由，也不自己开对话框。 */
export interface FirstRunHomeProps {
  onNewTicket(): void;
  onNewFeature(): void;
  /** 接线方 setRoute({ page: "settings", section: "features" })。 */
  onOpenSettings(): void;
}

/** 纯视图：没有 hook、没有请求（测试直接调用它取按钮的 onClick）。 */
export function FirstRunHomeView({ onNewTicket, onNewFeature, onOpenSettings }: FirstRunHomeProps): ReactElement {
  const t = S.firstRun;
  const steps = [
    { id: "ticket", step: t.stepTicket, label: S.newTicket, onClick: onNewTicket },
    { id: "feature", step: t.stepFeature, label: S.newFeature, onClick: onNewFeature },
  ];
  return (
    <section className="first-run" data-testid="first-run-home">
      <h1>{t.title}</h1>
      <p className="first-run-lede">{t.lede}</p>
      <p className="muted">{t.empty}</p>
      <div className="first-run-steps">
        {steps.map((s, i) => (
          <div key={s.id} className="first-run-step">
            <span className="first-run-num" aria-hidden="true">{i + 1}</span>
            <h3>{s.step.title}</h3>
            <p className="muted">{s.step.desc}</p>
            <button type="button" className={i === 0 ? "primary" : undefined} data-testid={`first-run-new-${s.id}`} onClick={s.onClick}>{s.label}</button>
          </div>
        ))}
      </div>
      <ol className="first-run-flow" data-testid="first-run-flow">
        {t.flow.map((node, i) => (
          // 箭头放在格子前面、跟格子在同一个 li 里：换行时整格（连同箭头）一起到下一行，不会伸到左边外面（BTL-249）。
          <li key={node} className={i === t.flow.length - 1 ? "first-run-node you" : "first-run-node"}>
            {i > 0 && <span className="first-run-arrow" aria-hidden="true">→</span>}
            <span className="first-run-box">
              {node}
              {i === 2 && <span className="first-run-note">{t.flowNote}</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className="first-run-defaults">
        {t.defaultsOff}{" "}
        <button type="button" className="link" data-testid="first-run-settings-link" onClick={onOpenSettings}>{t.openFeatureSettings}</button>
      </p>
    </section>
  );
}

/** 首页空状态（UI 重做 spec §5.5）：一句话说 Shipherd 做什么、两种开工方式、主流程、默认不对外。 */
export function FirstRunHome(props: FirstRunHomeProps): ReactElement {
  return <FirstRunHomeView {...props} />;
}
