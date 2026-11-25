import { describe, expect, it } from "vitest";
import { ReadScope } from "./read-scope";

describe("ReadScope", () => {
  it("computes once inside run and fresh outside it", () => {
    const scope = new ReadScope();
    let n = 0;
    const f = scope.memo(() => ++n);
    expect(scope.run(() => [f(), f(), f()])).toEqual([1, 1, 1]);
    // run 外：每次现读。
    expect([f(), f()]).toEqual([2, 3]);
    // 下一次 run 重新算。
    expect(scope.run(() => [f(), f()])).toEqual([4, 4]);
  });

  it("drops the memos when run throws, and does not cache a throw", () => {
    const scope = new ReadScope();
    let n = 0;
    let fail = true;
    const f = scope.memo(() => {
      if (fail) throw new Error("x");
      return ++n;
    });
    expect(() => scope.run(() => f())).toThrow("x");
    fail = false;
    expect(scope.run(() => [f(), f()])).toEqual([1, 1]);
    expect(() =>
      scope.run(() => {
        f();
        throw new Error("y");
      }),
    ).toThrow("y");
    expect(scope.run(() => f())).toBe(3);
  });

  it("a nested run shares the outer scope", () => {
    const scope = new ReadScope();
    let n = 0;
    const f = scope.memo(() => ++n);
    expect(scope.run(() => [f(), scope.run(() => f()), f()])).toEqual([1, 1, 1]);
    expect(f()).toBe(2);
  });

  it("keeps separate memos apart", () => {
    const scope = new ReadScope();
    const a = scope.memo(() => "a");
    const b = scope.memo(() => "b");
    expect(scope.run(() => [a(), b(), a()])).toEqual(["a", "b", "a"]);
  });
});
