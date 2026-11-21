import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import { sessionName } from "./names";

const s = (x: Partial<Session>): Session => ({ id: "x", ticketKey: null, featureId: null, epicId: null, fixesSession: null, butler: false, ...x }) as Session;

describe("sessionName (BTL-245)", () => {
  it("names each kind of session", () => {
    const heads: Record<string, Session> = {
      t: s({ ticketKey: "ABC-1" }), c: s({ featureId: 1 }), f: s({ featureId: 1, fixesSession: "t" }),
      e: s({ epicId: 2 }), b: s({ butler: true }), plain: s({ id: "plain" }),
    };
    const d = { head: (id: string) => heads[id] ?? null, featureName: () => "登录", epicName: () => "四月" };
    expect(sessionName(d, "t")).toBe("ABC-1");
    expect(sessionName(d, "c")).toBe("feature 登录 的总控");
    expect(sessionName(d, "f")).toBe("feature 登录 的修复 session");
    expect(sessionName(d, "e")).toBe("epic 四月 的 epic session");
    expect(sessionName(d, "b")).toBe("Butler 总控");
    expect(sessionName(d, null)).toBe("Butler");
    expect(sessionName(d, "plain")).toBe("plain");
    expect(sessionName(d, "gone")).toBe("gone");
  });
});
