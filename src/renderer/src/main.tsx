import { createRoot } from "react-dom/client";
import { startActivityLog } from "./activity-log";
import { api } from "./api";
import { App } from "./App";
import { browserLongTaskObserver, startLongTaskReporter } from "./diag";
import { migrateLegacyPrefs } from "./local-prefs";
import { setUiLang } from "./strings";
import "./styles.css";

// 改名前（BTL-260）的 butler.* 本地偏好搬到 shipherd.*：在任何组件读它们之前。
migrateLegacyPrefs();

// 拖文件进窗口时浏览器默认会导航到该文件，整个界面被替换；全局禁止。
for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => e.preventDefault());

// 性能诊断（BTL-242）：long task 每分钟报一次给主进程。
startLongTaskReporter({
  observe: browserLongTaskObserver,
  send: (t) => api.diagReport(t),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (h) => window.clearInterval(h as number),
});

// 实况窗口卡片上的工具调用：从启动起一直收（BTL-242），不只是实况挂着的时候。
startActivityLog();

// 先拿到语言再渲染（设计文档 2026-10-26）：拿不到就用中文。
api.language().then(setUiLang, () => setUiLang("zh")).finally(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
