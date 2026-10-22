import { sanitizeEnv } from "./sanitize";

// entry.ts 的第一个 import：在 StateCore 加载、读取 process.env 之前执行。
sanitizeEnv(process.env);
