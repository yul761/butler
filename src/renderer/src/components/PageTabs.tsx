import { useEffect, useState, type ReactNode } from "react";
import { saveTab, saveTabOpen, savedTab, savedTabOpen } from "../local-prefs";
import { clickTab, readTabState, toggleTabs, type TabState } from "../page-tabs";
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
 * 不挤掉别的块，也不挤占终端（终端至少占窗口一半高）。默认收起，让终端尽量大；点 tab 或右边的「展开」按钮展开，再点一下当前 tab 或「收起」按钮收起。每个页面记着展开还是收起、最近停在哪个 tab。
 * actions：放在 tab 条右边、不管停在哪个 tab 都点得到的按钮（新建 ticket、新建 feature）。
 */
export function PageTabs({ page, tabs, defaultTab, actions }: { page: string; tabs: PageTab[]; defaultTab: string; actions?: ReactNode }) {
  const panelId = `page-tabs-panel-${page.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const ids = tabs.map((t) => t.id);
  const read = () => ({ saved: savedTab(page), flag: savedTabOpen(page) });
  const [mem, setMem] = useState(read);
  useEffect(() => setMem(read()), [page]);
  const state: TabState = readTabState(mem.saved, mem.flag, ids, defaultTab);
  const tab = state.open ? tabs.find((t) => t.id === state.tab) : undefined;
  const apply = (next: TabState) => {
    saveTab(page, next.tab);
    saveTabOpen(page, next.open);
    setMem({ saved: next.tab, flag: next.open ? "1" : null });
  };
  return (
    <div className={tab ? "page-tabs" : "page-tabs collapsed"}>
      <div className="page-tabs-bar" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={!!tab && t.id === state.tab}
            className={["page-tab", `tab-${t.id}`, tab && t.id === state.tab ? "active" : "", t.className ?? ""].filter(Boolean).join(" ")}
            title={tab && t.id === state.tab ? S.tabCollapseHint : undefined}
            onClick={() => apply(clickTab(state, t.id))}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="page-tabs-toggle"
          aria-expanded={!!tab}
          aria-controls={tab ? panelId : undefined}
          title={tab ? S.tabToggleCollapseHint : S.tabToggleExpandHint}
          onClick={() => apply(toggleTabs(state))}
        >
          {tab ? `▾ ${S.tabCollapse}` : `▸ ${S.tabExpand}`}
        </button>
        {actions && <span className="page-tabs-actions">{actions}</span>}
      </div>
      {tab && (
        <div id={panelId} className={`page-tabs-panel tab-panel-${tab.id}`} role="tabpanel">
          {tab.content}
        </div>
      )}
    </div>
  );
}
