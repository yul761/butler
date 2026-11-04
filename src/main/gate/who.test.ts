import { afterEach, describe, expect, it } from "vitest";
import type { Epic, Feature, Ticket } from "../../shared/types";
import { setLang } from "../i18n";
import { makeWhoOf } from "./who";

const ticket = (key: string, featureId: number | null) => ({ key, featureId }) as Ticket;
const feature = (id: number, name: string, epicId: number | null) => ({ id, name, epicId }) as Feature;
const epic = (id: number, name: string) => ({ id, name }) as Epic;

function whoOf() {
  const tickets = [ticket("DMS-1", 1), ticket("DMS-2", 2), ticket("DMS-3", null), ticket("DMS-4", 9)];
  const features = [feature(1, "支付", 7), feature(2, "登录", null)];
  const epics = [epic(7, "结算改版")];
  return makeWhoOf({
    tickets: { get: (k) => tickets.find((t) => t.key === k) ?? null },
    features: { get: (id) => features.find((f) => f.id === id) ?? null },
    epics: { get: (id) => epics.find((e) => e.id === id) ?? null },
  });
}

describe("whoOf", () => {
  afterEach(() => setLang("zh"));

  it("names the epic and the feature of a ticket in an epic", () => {
    expect(whoOf()("DMS-1", "dms-1")).toBe("DMS-1（结算改版 / 支付）");
  });

  it("names the feature of a ticket in a feature without an epic", () => {
    expect(whoOf()("DMS-2", "dms-2")).toBe("DMS-2（登录）");
  });

  it("gives only the key for a standalone ticket, a missing feature, or a ticket that no longer exists", () => {
    expect(whoOf()("DMS-3", "dms-3")).toBe("DMS-3");
    expect(whoOf()("DMS-4", "dms-4")).toBe("DMS-4");
    expect(whoOf()("GONE-1", "gone")).toBe("GONE-1");
  });

  it("falls back to the branch when there is no ticket", () => {
    expect(whoOf()(null, "feature/x")).toBe("feature/x");
  });

  it("uses half-width parentheses in English", () => {
    setLang("en");
    expect(whoOf()("DMS-1", "dms-1")).toBe("DMS-1 (结算改版 / 支付)");
  });
});
