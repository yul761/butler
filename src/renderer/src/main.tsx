import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// 拖文件进窗口时浏览器默认会导航到该文件，整个界面被替换；全局禁止。
for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(<App />);
