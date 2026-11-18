/// <reference types="electron-vite/node" />
// 只在应用里引用（index.ts）：vitest 不认识 ?nodeWorker。
import createWorker from "./worker?nodeWorker";
import { workerRunner, type JobRunner } from "./runner";

export const baselineWorkerRunner: JobRunner = workerRunner((job) => createWorker({ workerData: job }));
