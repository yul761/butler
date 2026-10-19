import { describe, expect, it } from "vitest";
import { extractTicketKey, isValidTicketKey, renderBranch } from "./ticket-key";

describe("ticket keys", () => {
  it("validates whole keys", () => {
    expect(isValidTicketKey("PROJ-123")).toBe(true);
    expect(isValidTicketKey("AB2-1")).toBe(true);
    expect(isValidTicketKey("proj-123")).toBe(false);
    expect(isValidTicketKey("PROJ-123x")).toBe(false);
    expect(isValidTicketKey("")).toBe(false);
  });

  it("extracts keys from branches and prose, case-insensitively, upper-cased", () => {
    expect(extractTicketKey("feature/proj-42-login")).toBe("PROJ-42");
    expect(extractTicketKey("修一下 PROJ-7 的配置")).toBe("PROJ-7");
    expect(extractTicketKey("main")).toBeNull();
    expect(extractTicketKey("bump v2-api")).toBeNull();
    expect(extractTicketKey("PROJ-77")).toBe("PROJ-77");
  });

  it("supports a custom pattern", () => {
    expect(extractTicketKey("fix #123 now", "#\\d+")).toBe("#123");
  });

  it("renders branch templates", () => {
    expect(renderBranch("feature/{key}", "PROJ-1")).toBe("feature/PROJ-1");
  });
});
