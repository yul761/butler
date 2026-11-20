import { useEffect, useRef, useState, type ReactNode } from "react";
import { saveTab, savedTab } from "../local-prefs";
import { landingDue, landingKey, pickTab, resolveTab } from "../page-tabs";

export interface PageTab {
  id: string;
  label: ReactNode;
  /** 只有当前 tab 的内容会渲染。 */
  content: ReactNode;
  /** 加在 tab 按钮上，比如有东西轮到你时「概况」标红。 */
  className?: string;
}

/**
 * 页面上半部分的 tab：一个 tab 一块，同一时间只显示一块，永远有一个选中，内容多了在自己的框里滚动。
 * 每个页面记着最近停在哪个 tab；forceTab 是落点（比如从「去看看」进来），变化时选中它并记住。
 * forceSeq：同一个 forceTab 要再落一次时（比如概况里的按钮又点了一次「去终端」），调用方把它加一。
 * actions：放在 tab 条右边、不管停在哪个 tab 都点得到的按钮（新建 ticket、新建 feature）。
 */
export function PageTabs({ page, tabs, defaultTab, forceTab, forceSeq, actions }: {
  page: string; tabs: PageTab[]; defaultTab: string; forceTab?: string | null; forceSeq?: number; actions?: ReactNode;
}) {
  const panelId = `page-tabs-panel-${page.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const ids = tabs.map((t) => t.id);
  const [saved, setSaved] = useState<string | null>(() => resolveTab(savedTab(page), forceTab, ids, defaultTab));
  useEffect(() => setSaved(savedTab(page)), [page]);
  const land = `${page}|${landingKey(forceTab, forceSeq)}`;
  /** 已经落过的那一次（页面 + 落点）：目标 tab 后出现时补落，落过的不再落。 */
  const landed = useRef<string | null>(null);
  const idsKey = ids.join(",");
  useEffect(() => {
    // 落点撤掉了：下次同一个落点再来时照样落（同以前按 land 变化触发）。
    if (forceTab == null) landed.current = null;
    if (forceTab == null || !landingDue(forceTab, ids, land, landed.current)) return;
    landed.current = land;
    saveTab(page, forceTab);
    setSaved(forceTab);
  }, [page, land, idsKey]);
  // forceTab 只在变化时落点一次（上面的 effect 把它存进 saved），之后用户点哪个就是哪个。
  const current = pickTab(saved, ids, defaultTab);
  const tab = tabs.find((t) => t.id === current);
  const pick = (id: string) => {
    saveTab(page, id);
    setSaved(id);
  };
  return (
    <div className="page-tabs">
      <div className="page-tabs-bar" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === current}
            aria-controls={t.id === current ? panelId : undefined}
            className={["page-tab", `tab-${t.id}`, t.id === current ? "active" : "", t.className ?? ""].filter(Boolean).join(" ")}
            onClick={() => pick(t.id)}
          >
            {t.label}
          </button>
        ))}
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
