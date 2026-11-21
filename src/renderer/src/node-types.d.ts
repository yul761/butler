/**
 * web 项目里的几个测试（读文件、起子进程）和 src/shared/mailbox.ts（NodeJS.Platform）要 Node 的类型。
 * 以前是 src/main/strings.ts 经 delivery-guard、cross-spawn 间接带进来的；那条 import 拆掉以后在这里明说（BTL-246）。
 */
/// <reference types="node" />
