import { useEffect, useRef, useState } from "react";
import { isSettingsTab, sectionTarget, SETTINGS_TABS, type AdvancedGroupId, type SettingsSection, type SettingsTabId } from "../../../shared/settings-layout";
import type { HealthReport } from "../../../shared/types";
import { api } from "../api";
import { savedTab, saveTab } from "../local-prefs";
import { S } from "../strings";
import { AdvancedSettings } from "./AdvancedSettings";
import { BasicSettings } from "./BasicSettings";
import { FeatureSettings } from "./FeatureSettings";
import { HealthSettings } from "./HealthSettings";
import { AboutSettings } from "./AboutSettings";
import { WorkflowSettings } from "./WorkflowParts";
import { reportError } from "../errors";

/** 没有 section 时回到上次看的 tab；记录不对就是「基本」。 */
function initialTab(section: SettingsSection | undefined): SettingsTabId {
  if (section) return sectionTarget(section).tab;
  const saved = savedTab("settings");
  return isSettingsTab(saved) ? saved : "basic";
}

/** 设置页（UI 重做 spec §5.3）：基本 / 功能 / 高级 / 健康检查 / 关于（BTL-253）。 */
export function SettingsPage({ onRerunWizard, section, nonce, onOpenShipherd }: { onRerunWizard: () => void; section?: SettingsSection; nonce?: number; onOpenShipherd?: (sessionId: string) => void }) {
  const [tab, setTab] = useState<SettingsTabId>(() => initialTab(section));
  const [openGroup, setOpenGroup] = useState<AdvancedGroupId | null>(() => sectionTarget(section).group);
  useEffect(() => {
    if (!section) return;
    const t = sectionTarget(section);
    setTab(t.tab);
    setOpenGroup(t.group);
  }, [section, nonce]);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 只采用最近一次的结果：进页面时的检测可能很慢（Windows 上经 cmd.exe 跑 claude），
  // 期间保存 claude 路径后拿到的新结果不能被晚到的旧结果盖掉。
  const seq = useRef(0);
  async function run(fn: () => Promise<HealthReport>) {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (mine === seq.current) setReport(r);
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }
  /** 子组件（保存 claude 路径后）直接给的新结果：作废还在路上的旧检测。 */
  function applyHealth(r: HealthReport) {
    seq.current++;
    setBusy(false);
    setReport(r);
  }

  useEffect(() => {
    void run(api.health);
  }, []);

  function choose(t: SettingsTabId) {
    if (t === tab) return; // 再点当前 tab 不动：链接打开的那一组别被收起
    setTab(t);
    setOpenGroup(null);
    saveTab("settings", t);
  }
  /** 功能页「N 个仓库另有设置」：到高级，展开那一组。 */
  function openAdvanced(group: AdvancedGroupId) {
    setTab("advanced");
    setOpenGroup(group);
    saveTab("settings", "advanced");
  }

  return (
    <div className="page">
      <div className="settings-tabs" role="tablist">
        {SETTINGS_TABS.map((t) => (
          <button key={t} role="tab" data-testid={`settings-tab-${t}`} aria-selected={tab === t} className={tab === t ? "page-tab active" : "page-tab"} onClick={() => choose(t)}>
            {S.set.tabs[t]}
          </button>
        ))}
      </div>
      {tab === "basic" &&
        (report ? <BasicSettings report={report} onHealth={applyHealth} onRerunWizard={onRerunWizard} /> : <p className="empty">{error ?? S.loading}</p>)}
      {tab === "features" && <FeatureSettings onOpenAdvanced={openAdvanced} />}
      {tab === "workflow" && <WorkflowSettings onAskClaude={() => void askClaude(onOpenShipherd)} />}
      {tab === "advanced" && <AdvancedSettings openGroup={openGroup} />}
      {tab === "health" && (
        <HealthSettings
          report={report}
          busy={busy}
          error={error}
          onRecheck={() => void run(api.health)}
          onInstall={() => void run(api.installHooks)}
          onUninstall={() => void run(api.uninstallHooks)}
          scrollToAvailability={section === "health"}
        />
      )}
      {tab === "about" && <AboutSettings />}
    </div>
  );
}

/**
 * 「用 Claude 设置」（BTL-273）：和总控页一样经 openShipherdSession 打开 Shipherd 总控（开着的就用它），把开头的话填进输入框，
 * 再跳到总控页、聚焦返回的那个终端。打不开时说原因。
 */
export async function askClaude(onOpen: ((sessionId: string) => void) | undefined): Promise<void> {
  try {
    const r = await api.openShipherdSession({ prefill: S.workflow.prefill });
    if (r.ok) onOpen?.(r.termId);
    else reportError(new Error(S.shipherdOpenErrors[r.reason] ?? S.openErrors[r.reason] ?? r.reason));
  } catch (e) {
    reportError(e);
  }
}
