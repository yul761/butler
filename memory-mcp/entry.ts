// 给 claude 挂载的 StateCore MCP server（设计文档 8.4）。
// 顺序就是执行顺序（ES 模块按 import 的先后求值，esbuild 打包后保持不变）：先清掉环境变量里的模型 key（R1），
// 再加载 statecore-mcp 的 bin：它在加载时解析 --data、读 STATECORE_SCOPE，经 stdio 提供 MCP。
import "./clean-env";
import "statecore-mcp";
