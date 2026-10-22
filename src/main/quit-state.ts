/**
 * 退出状态：“关窗口只是藏到托盘”靠 quitting 区分真退出。
 * 注销 / 关机（session-end、shutdown）先置 quitting 再退出，且只退出一次；
 * before-quit 只置 quitting（退出已经在进行）。
 */
export interface QuitState {
  readonly quitting: boolean;
  /** 只置 quitting（before-quit 用）。 */
  markQuitting(): void;
  /** 先置 quitting，再调用一次 quit；重复调用无副作用。 */
  requestQuit(): void;
}

export function createQuitState(quit: () => void): QuitState {
  let quitting = false;
  let requested = false;
  return {
    get quitting() {
      return quitting;
    },
    markQuitting() {
      quitting = true;
    },
    requestQuit() {
      quitting = true;
      if (requested) return;
      requested = true;
      quit();
    },
  };
}
