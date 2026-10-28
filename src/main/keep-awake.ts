/** Electron powerSaveBlocker 里用到的部分（测试注入假的）。 */
export interface PowerBlocker {
  start(type: "prevent-app-suspension" | "prevent-display-sleep"): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export interface KeepAwakeDeps {
  blocker: PowerBlocker;
  /** 开关状态变了：托盘菜单、提示文字和界面跟着更新。 */
  onChange: (on: boolean) => void;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * 防休眠开关：开着的时候电脑不会因为闲置而睡眠，屏幕也不熄（盖子开着让 session 自己跑）。
 * 只在内存里，Butler 每次启动都是关的；进入睡眠（合上盖子）和退出时由主进程关掉。
 */
export class KeepAwake {
  private id: number | null = null;

  constructor(private readonly d: KeepAwakeDeps) {}

  isOn(): boolean {
    return this.id !== null && this.d.blocker.isStarted(this.id);
  }

  set(on: boolean): void {
    if (on === this.isOn()) return;
    if (on) {
      // prevent-display-sleep 同时阻止系统闲置睡眠。
      this.id = this.d.blocker.start("prevent-display-sleep");
    } else {
      if (this.id !== null && this.d.blocker.isStarted(this.id)) this.d.blocker.stop(this.id);
      this.id = null;
    }
    try {
      this.d.onChange(on);
    } catch (e) {
      this.d.log?.("keep-awake onChange failed", e);
    }
  }
}
