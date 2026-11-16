import { describe, expect, it } from "vitest";
import { prUrlKey, prUrlParts } from "./pr-url";

describe("prUrlKey", () => {
  it("trims, strips the trailing slash and lower-cases", () => {
    expect(prUrlKey(" https://github.com/A/B/pull/3/ ")).toBe("https://github.com/a/b/pull/3");
  });
});

describe("prUrlParts", () => {
  it("parses a github.com PR", () => {
    expect(prUrlParts("https://github.com/Acme/App/pull/12")).toEqual({ host: "github.com", slug: "acme/app", number: 12 });
  });
  it("keeps the host in the slug for enterprise hosts", () => {
    expect(prUrlParts("https://ghe.acme.io/team/app/pull/3/files")?.slug).toBe("ghe.acme.io/team/app");
  });
  it("rejects non-PR urls", () => {
    expect(prUrlParts("https://github.com/a/b/issues/3")).toBeNull();
    expect(prUrlParts("")).toBeNull();
  });
});
