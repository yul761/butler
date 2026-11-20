import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnBoard } from "../../shared/turn";
import { boardFor, createTurnBoardLoader, TURN_DEBOUNCE_MS } from "./turn-board-loader";

const board = (you: number): TurnBoard => ({ counts: { you } } as unknown as TurnBoard);

/** 手动控制的 fetch：每次调用排一个待定的 promise，测试决定谁先回来。 */
function harness() {
  const pending: { resolve: (b: TurnBoard) => void; reject: (e: unknown) => void }[] = [];
  let listener: (() => void) | null = null;
  const off = vi.fn(() => { listener = null; });
  const d = {
    fetch: vi.fn(() => new Promise<TurnBoard>((resolve, reject) => pending.push({ resolve, reject }))),
    subscribe: vi.fn((cb: () => void) => { listener = cb; return off; }),
    onBoard: vi.fn(),
    onError: vi.fn(),
  };
  return { d, pending, off, fire: () => listener?.(), listening: () => listener !== null };
}
const flush = () => Promise.resolve().then(() => Promise.resolve());

describe("createTurnBoardLoader", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fetches once on start and writes the board", async () => {
    const h = harness();
    createTurnBoardLoader(h.d);
    expect(h.d.fetch).toHaveBeenCalledTimes(1);
    h.pending[0].resolve(board(1));
    await flush();
    expect(h.d.onBoard).toHaveBeenCalledWith(board(1));
  });

  it("only the latest fetch is written: a slow earlier answer is dropped", async () => {
    const h = harness();
    const l = createTurnBoardLoader(h.d);
    l.reload();
    h.pending[1].resolve(board(2));
    await flush();
    h.pending[0].resolve(board(1));
    h.pending[0].reject("late");
    await flush();
    expect(h.d.onBoard.mock.calls).toEqual([[board(2)]]);
    expect(h.d.onError).not.toHaveBeenCalled();
  });

  it("turn:changed bursts collapse into one fetch after the debounce", async () => {
    const h = harness();
    createTurnBoardLoader(h.d);
    h.fire(); h.fire();
    vi.advanceTimersByTime(TURN_DEBOUNCE_MS - 1);
    h.fire();
    vi.advanceTimersByTime(TURN_DEBOUNCE_MS - 1);
    expect(h.d.fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(h.d.fetch).toHaveBeenCalledTimes(2);
  });

  it("a failed fetch reports the error and leaves the old board alone", async () => {
    const h = harness();
    const l = createTurnBoardLoader(h.d);
    h.pending[0].resolve(board(1));
    await flush();
    l.reload();
    h.pending[1].reject(new Error("db busy"));
    await flush();
    expect(h.d.onError).toHaveBeenCalledWith("db busy");
    expect(h.d.onBoard).toHaveBeenCalledTimes(1);
  });

  it("dispose unsubscribes, cancels a pending debounce and drops late answers", async () => {
    const h = harness();
    const l = createTurnBoardLoader(h.d);
    h.fire();
    l.dispose();
    expect(h.off).toHaveBeenCalledTimes(1);
    expect(h.listening()).toBe(false);
    vi.advanceTimersByTime(TURN_DEBOUNCE_MS * 2);
    expect(h.d.fetch).toHaveBeenCalledTimes(1);
    h.pending[0].resolve(board(1));
    await flush();
    expect(h.d.onBoard).not.toHaveBeenCalled();
  });
});

describe("boardFor", () => {
  it("a board fetched for another filter is not shown (switching scope shows loading, not the old scope)", () => {
    const b = board(1);
    expect(boardFor({ key: "a", board: b }, "a")).toBe(b);
    expect(boardFor({ key: "a", board: b }, "b")).toBeNull();
  });
});
