import { useEffect, useState, type ReactNode } from "react";
import { saveTab, savedTab } from "../local-prefs";
import { clickTab, pickTab } from "../page-tabs";
import { S } from "../strings";

export interface PageTab {
  id: string;
  label: ReactNode;
  /** 只有当前 tab 的内容会渲染。 */
  content: ReactNode;
  /** 加在 tab 按钮上，比如「待你决定」有东西时标红。 */
  className?: string;
}

/**
 * feature 页、epic 页、Butler 总控页终端上面的部分：一个 tab 一块，同一时间只显示一块，内容多了在自己的框里滚动，
 * 不挤掉别的块，也不挤占终端（终端至少占窗口一半高）。再点一下当前 tab 收起。每个页面记着停在哪个 tab。
 * actions：放在 tab 条右边、不管停在哪个 tab 都点得到的按钮（新建 ticket、新建 feature）。
 */
export function PageTabs({ page, tabs, defaultTab, actions }: { page: string; tabs: PageTab[]; defaultTab: string; actions?: ReactNode }) {
  const ids = tabs.map((t) => t.id);
  const [saved, setSaved] = useState(() => savedTab(page));
  useEffect(() => setSaved(savedTab(page)), [page]);
  const current = pickTab(saved, ids, defaultTab);
  const tab = tabs.find((t) => t.id === current);
  const choose = (id: string) => {
    const next = clickTab(current, id);
    saveTab(page, next);
    setSaved(next);
  };
  return (
    <div className={tab ? "page-tabs" : "page-tabs collapsed"}>
      <div className="page-tabs-bar" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === current}
            className={["page-tab", `tab-${t.id}`, t.id === current ? "active" : "", t.className ?? ""].filter(Boolean).join(" ")}
            title={t.id === current ? S.tabCollapseHint : undefined}
            onClick={() => choose(t.id)}
          >
            {t.label}
          </button>
        ))}
        {actions && <span className="page-tabs-actions">{actions}</span>}
      </div>
      {tab && (
        <div className={`page-tabs-panel tab-panel-${tab.id}`} role="tabpanel">
          {tab.content}
        </div>
      )}
    </div>
  );
}
