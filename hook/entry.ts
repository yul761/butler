import { main } from "./butler-hook";

// 设计文档 4.3：任何异常都以退出码 0 静默结束，绝不阻塞 Claude Code。
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

void main().finally(() => process.exit(0));
