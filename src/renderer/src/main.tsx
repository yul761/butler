import { createRoot } from "react-dom/client";
import { api } from "./api";
import { App } from "./App";
import { browserLongTaskObserver, startLongTaskReporter } from "./diag";
import { setUiLang } from "./strings";
import "./styles.css";

// 拖文件进窗口时浏览器默认会导航到该文件，整个界面被替换；全局禁止。
for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => e.preventDefault());

// 性能诊断（BTL-242）：long task 每分钟报一次给主进程。
startLongTaskReporter({
  observe: browserLongTaskObserver,
  send: (t) => api.diagReport(t),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (h) => window.clearInterval(h as number),
});

// 先拿到语言再渲染（设计文档 2026-10-26）：拿不到就用中文。
api.language().then(setUiLang, () => setUiLang("zh")).finally(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
