# BTL-241：总控页撑满 + 右栏可折叠（addendum）

- 撑满：`.butler-page .control-split { flex: 1 1 auto }`。分栏是 `.ticket-page` 的直接子元素，之前没有 flex-grow；右栏 `contain: size`，行高只看左栏，所以左栏终端（`.terminals` 的 flex-grow）随之长高。
- 折叠：`ControlSplit` 在分栏线上放一个按钮（窄屏单列时隐藏）；收起后不渲染右栏，网格变单列，左边占满。
- 记忆：按页面种类（`epic` / `feature` / `butler`）各记一个，复用 `local-prefs` 的 `isCollapsed/setCollapsed`（id `control-right:<种类>`，读写已包 try/catch）。没有按具体 epic/feature 记，因为用户的偏好是视图习惯，不是内容属性。
- 重新 fit：终端自己的 ResizeObserver 在宽度变化时会 fit，不需要额外代码；e2e 验证收起后左栏变宽、终端仍可见。
- 文案：`S.lay.ctlCollapse / ctlExpand`，中英两份。
- review 后的修正：收起只用 CSS 藏右栏（不卸载，对话草稿和选中的 session 不丢），且只在并排（>900px）生效，窄屏单列时右栏照常显示。实际 flex-shrink 因 `.ticket-page > :not(.page-tabs)` 同优先级且更靠后而是 0，即 `1 0 auto`，增长不受影响。
