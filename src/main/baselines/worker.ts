// worker 线程的入口（electron-vite 的 ?nodeWorker 打包）：收到一个活就跑，跑完主进程结束这个 worker。
import { parentPort, workerData } from "node:worker_threads";
import { runJob, type Job } from "./jobs";

if (parentPort) {
  const port = parentPort;
  void runJob(workerData as Job, (m) => port.postMessage(m));
}
