import { describe, expect, it, vi } from "vitest";
import { onOpenFeedback, openFeedback } from "./feedback-bus";

describe("feedback bus", () => {
  it("delivers open requests until unsubscribed", () => {
    const l = vi.fn();
    const off = onOpenFeedback(l);
    openFeedback({ kind: "first-run", step: "hooks" });
    expect(l).toHaveBeenCalledWith({ kind: "first-run", step: "hooks" });
    off();
    openFeedback();
    expect(l).toHaveBeenCalledTimes(1);
  });
});
