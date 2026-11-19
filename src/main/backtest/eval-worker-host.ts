/// <reference types="electron-vite/node" />
// 只在应用里引用（index.ts）：vitest 不认识 ?nodeWorker。
import createWorker from "./eval-worker?nodeWorker";
import { workerEvaluator, type Evaluator } from "./evaluator";

export const backtestWorkerEvaluator: Evaluator = workerEvaluator((input) => createWorker({ workerData: input }));
