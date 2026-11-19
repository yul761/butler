import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { PermissionProfileRepo } from "../db/interrupts-repo";
import { LessonsRepo } from "../db/lessons-repo";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { memDb, tempDir } from "../test-utils";
import { ConfigIoService, defaultRegistry } from ".";

function home() {
  const db = memDb();
  const repo = new LessonsRepo(db);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  let t = 1000;
  const now = () => (t += 10);
  let version = 1;
  const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => version, set: (v) => (version = v) }, now });
  const io = new ConfigIoService({ db, repo, policies, recorder, registry: defaultRegistry(), butlerVersion: "3.0.0", backupDir: join(tempDir(), "b"), now });
  return { io, profiles: new PermissionProfileRepo(db) };
}

const all = { scope: { kind: "all" as const }, options: { content: "all" as const, includeSourceUrls: false } };

async function preview(b: ReturnType<typeof home>, doc: unknown) {
  const pr = await b.io.previewText(JSON.stringify(doc));
  if (!pr.ok) throw new Error(`preview: ${pr.reason}`);
  return { token: pr.preview.token, section: pr.preview.sections.find((s) => s.id === "permissions") };
}

describe("permissions config section (ws-j)", () => {
  it("exports decided rules only, and imported confirmations wait as pending", async () => {
    const a = home();
    a.profiles.set({ slug: "acme/app", rule: "Bash(gh pr view:*)", status: "confirmed", source: "history", runs: 5, sessions: 2, at: 1 });
    a.profiles.set({ slug: "acme/app", rule: "Bash(gh run list:*)", status: "dismissed", source: "history", at: 1 });
    a.profiles.set({ slug: "acme/app", rule: "Bash(gh pr list:*)", status: "pending", source: "import", at: 1 });
    const doc = a.io.exportDoc(all)!;
    expect(doc.sections.permissions).toEqual([
      { repo: "acme/app", rule: "Bash(gh pr view:*)", status: "confirmed" },
      { repo: "acme/app", rule: "Bash(gh run list:*)", status: "dismissed" },
    ]);
    expect(a.io.exportDoc({ ...all, options: { ...all.options, content: "lessons" } })!.sections.permissions).toBeUndefined();

    const b = home();
    const p = await preview(b, doc);
    expect(p.section?.rows.map((r) => r.status)).toEqual(["added", "added"]);
    const r = b.io.apply({ token: p.token, mode: "merge" });
    if (!r.ok) throw new Error("apply");
    expect(b.profiles.get("acme/app", "Bash(gh pr view:*)")).toMatchObject({ status: "pending", source: "import" });
    expect(b.profiles.get("acme/app", "Bash(gh run list:*)")).toMatchObject({ status: "dismissed" });
    expect(b.profiles.confirmed(["acme/app"])).toEqual([]);
    expect((await preview(b, doc)).section?.rows.every((x) => x.status === "unchanged")).toBe(true);
  });

  it("never imports a write rule", async () => {
    const a = home();
    const doc = a.io.exportDoc(all)!;
    const bad = { ...doc, sections: { ...doc.sections, permissions: [{ repo: "acme/app", rule: "Bash(git push:*)", status: "confirmed" }, { repo: "acme/app", rule: "Bash(gh pr view:*)", status: "confirmed" }] } };
    const b = home();
    const pr = await b.io.previewText(JSON.stringify(bad));
    if (pr.ok) {
      const r = b.io.apply({ token: pr.preview.token, mode: "merge" });
      expect(r.ok).toBe(true);
    }
    expect(b.profiles.get("acme/app", "Bash(git push:*)")).toBeNull();
  });
});
