// 把导出成 lint 用的 Node 检查脚本（src/main/baselines/export/runtime-entry.ts + check-rules）打成一段文字，
// 写进 src/main/baselines/export/node-runtime.generated.ts。改了 check-rules / glob / runtime-entry 之后跑一次：
//   node scripts/build-check-runtime.mjs
// 有测试比较生成的文件和重新打包的结果，忘了跑会失败。
import { writeFileSync } from "node:fs";
import { bundleCheckRuntime, GENERATED_PATH, renderGenerated } from "./check-runtime-bundle.mjs";

const code = await bundleCheckRuntime();
writeFileSync(GENERATED_PATH, renderGenerated(code));
console.log(`wrote ${GENERATED_PATH} (${code.length} chars)`);
