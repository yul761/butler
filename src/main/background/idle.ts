/**
 * 用户在不在（工作流 L，设计 addendum 第 2 节）。只看人：系统多久没有键鼠输入、屏幕锁没锁、机器睡没睡。
 * Claude session 在不在干活、休眠没有，都不算「用户活跃」。
 */
export interface IdleSignal {
  /** 系统多久没有键鼠输入（秒）。 */
  idleSeconds(): number;
  /** 屏幕锁着（或系统睡着、macOS 切到了别的用户）。 */
  locked(): boolean;
  /** 锁屏、解锁、睡眠、唤醒（macOS 还有切换用户）时调用。 */
  subscribe(fn: () => void): () => void;
  dispose?(): void;
}

/** Electron powerMonitor 里用得到的部分。 */
export interface PowerMonitorLike {
  getSystemIdleTime(): number;
  getSystemIdleState(threshold: number): "active" | "idle" | "locked" | "unknown";
  on(event: string, fn: () => void): unknown;
  removeListener(event: string, fn: () => void): unknown;
}

/** 两个平台都有的事件（macOS：会话锁屏通知；Windows：WTS 会话通知）。 */
export const COMMON_IDLE_EVENTS = ["lock-screen", "unlock-screen", "suspend", "resume"] as const;
/** 只有 macOS 有：快速切换用户时本会话变成非活跃 / 活跃。 */
export const MAC_IDLE_EVENTS = ["user-did-resign-active", "user-did-become-active"] as const;

/**
 * 生产实现。getSystemIdleTime：macOS 上是 CGEventSource，Windows 上是 GetLastInputInfo；getSystemIdleState 在两个平台
 * 都能报 locked。锁屏 / 睡眠 / 切走用户这几个事件里记下「离开」，解锁 / 唤醒 / 切回来清掉，以事件为准（有的系统锁屏时
 * getSystemIdleState 报 unknown）。
 */
export function electronIdleSignal(pm: PowerMonitorLike, platform: NodeJS.Platform): IdleSignal {
  const listeners = new Set<() => void>();
  let away = false;
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  const handlers: Record<string, () => void> = {
    "lock-screen": () => { away = true; emit(); },
    suspend: () => { away = true; emit(); },
    "user-did-resign-active": () => { away = true; emit(); },
    "unlock-screen": () => { away = false; emit(); },
    resume: () => { away = false; emit(); },
    "user-did-become-active": () => { away = false; emit(); },
  };
  const events: string[] = [...COMMON_IDLE_EVENTS, ...(platform === "darwin" ? MAC_IDLE_EVENTS : [])];
  for (const e of events) pm.on(e, handlers[e]);
  return {
    idleSeconds: () => {
      try {
        return pm.getSystemIdleTime();
      } catch {
        return 0;
      }
    },
    locked: () => {
      if (away) return true;
      try {
        return pm.getSystemIdleState(1) === "locked";
      } catch {
        return false;
      }
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose: () => {
      for (const e of events) pm.removeListener(e, handlers[e]);
      listeners.clear();
    },
  };
}

/** 用户空闲：锁屏，或者 minutes 分钟没有输入。 */
export function userIdle(s: IdleSignal, minutes: number): boolean {
  return s.locked() || s.idleSeconds() >= minutes * 60;
}

/** 测试和 e2e 用：空闲秒数、锁屏状态都可以设。 */
export function fakeIdleSignal(init: { idleSeconds?: number; locked?: boolean } = {}): IdleSignal & { set(v: { idleSeconds?: number; locked?: boolean }): void } {
  let idle = init.idleSeconds ?? 0;
  let lock = init.locked ?? false;
  const listeners = new Set<() => void>();
  return {
    idleSeconds: () => idle,
    locked: () => lock,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set: (v) => {
      if (v.idleSeconds !== undefined) idle = v.idleSeconds;
      if (v.locked !== undefined) lock = v.locked;
      for (const fn of [...listeners]) fn();
    },
  };
}
