import { describe, expect, it } from "vitest";
import { parseGateRequest } from "./gate";

const base = { v: 1, phase: "pre", action: { kind: "push", dir: null, target: "main" }, cwd: "/repo", session: "s1", ticket: "P-1" };

describe("parseGateRequest", () => {
  it("accepts valid pre and post requests", () => {
    expect(parseGateRequest(base)).toEqual(base);
    expect(parseGateRequest({ ...base, phase: "post", session: null, ticket: null })).toMatchObject({ phase: "post", session: null, ticket: null });
  });

  it("accepts every action kind", () => {
    for (const action of [
      { kind: "pr_merge", dir: "/x", pr: "12", repo: null },
      { kind: "pr_merge", dir: null, pr: null, repo: null },
      { kind: "local_merge", dir: null, source: "feat" },
      { kind: "push", dir: "/x", target: "main" },
      { kind: "push", dir: null, target: "main", source: "feat" },
      { kind: "switch", dir: null, branch: "b", create: true },
      { kind: "pr_create", dir: null, head: null, draft: false, repo: null },
      { kind: "pr_create", dir: "/x", head: "feat", draft: true, repo: "o/r" },
    ]) expect(parseGateRequest({ ...base, action })).toMatchObject({ action });
  });

  it("accepts a pr_merge repo, and reads an old hook's request without one as null (BTL-267)", () => {
    expect(parseGateRequest({ ...base, action: { kind: "pr_merge", dir: null, pr: "3", repo: "org/r" } })?.action).toEqual({ kind: "pr_merge", dir: null, pr: "3", repo: "org/r" });
    expect(parseGateRequest({ ...base, action: { kind: "pr_merge", dir: null, pr: "3" } })?.action).toEqual({ kind: "pr_merge", dir: null, pr: "3", repo: null });
    expect(parseGateRequest({ ...base, action: { kind: "pr_merge", dir: null, pr: "3", repo: 7 } })).toBeNull();
  });

  it("reads an optional prCreate, and refuses one that is not a pr_create (BTL-273)", () => {
    const prCreate = { kind: "pr_create", dir: null, head: null, draft: false, repo: null };
    expect(parseGateRequest({ ...base, prCreate })?.prCreate).toEqual(prCreate);
    expect(parseGateRequest(base)).not.toHaveProperty("prCreate");
    expect(parseGateRequest({ ...base, prCreate: { kind: "switch", dir: null, branch: "b", create: true } })).toBeNull();
  });

  it("leaves out a push source that was not given", () => {
    expect(parseGateRequest(base)?.action).not.toHaveProperty("source");
  });

  it("accepts Windows and UNC absolute cwd", () => {
    for (const cwd of ["C:\\repo", "C:/repo", "\\\\server\\share"]) expect(parseGateRequest({ ...base, cwd })).not.toBeNull();
  });

  it("rejects bad version, phase, action, cwd and oversized strings", () => {
    expect(parseGateRequest(null)).toBeNull();
    expect(parseGateRequest("x")).toBeNull();
    expect(parseGateRequest({ ...base, v: 2 })).toBeNull();
    expect(parseGateRequest({ ...base, phase: "mid" })).toBeNull();
    expect(parseGateRequest({ ...base, action: { kind: "rebase", dir: null } })).toBeNull();
    expect(parseGateRequest({ ...base, action: { kind: "push", dir: null } })).toBeNull();
    expect(parseGateRequest({ ...base, action: { kind: "push", dir: null, target: "main", source: 5 } })).toBeNull();
    expect(parseGateRequest({ ...base, action: { kind: "push", dir: null, target: "main", source: "" } })).toBeNull();
    expect(parseGateRequest({ ...base, action: { kind: "switch", dir: null, branch: "b", create: "yes" } })).toBeNull();
    expect(parseGateRequest({ ...base, cwd: "repo" })).toBeNull();
    expect(parseGateRequest({ ...base, cwd: "" })).toBeNull();
    expect(parseGateRequest({ ...base, session: 5 })).toBeNull();
    expect(parseGateRequest({ ...base, action: { kind: "push", dir: null, target: "x".repeat(4097) } })).toBeNull();
    expect(parseGateRequest({ ...base, cwd: "/" + "x".repeat(4096) })).toBeNull();
  });
});
