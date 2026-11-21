import { describe, expect, it } from "vitest";
import { PtySubscriptions } from "./pty-subscriptions";

describe("PtySubscriptions (BTL-242)", () => {
  it("counts attaches, so a second view keeps data flowing until both detach", () => {
    const s = new PtySubscriptions();
    expect(s.has("t")).toBe(false);
    s.attach("t");
    s.attach("t");
    s.detach("t");
    expect(s.has("t")).toBe(true);
    s.detach("t");
    expect(s.has("t")).toBe(false);
    s.detach("t");
    s.attach("t");
    expect(s.has("t")).toBe(true);
  });

  it("clear forgets everything (renderer reloaded)", () => {
    const s = new PtySubscriptions();
    s.attach("a");
    s.clear();
    expect(s.has("a")).toBe(false);
  });
});
