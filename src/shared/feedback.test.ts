import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEEDBACK_KINDS, FEEDBACK_TEMPLATES, FEEDBACK_URL_MAX, feedbackUrl, isFeedbackKind, type FeedbackEnv } from "./feedback";

const env: FeedbackEnv = { butler: "4.0.0", os: "macOS 15.1.0", platform: "darwin", arch: "arm64", claude: "2.1.3" };
const params = (url: string) => new URL(url).searchParams;

describe("feedbackUrl", () => {
  it("points at the repo's new issue page with the kind's template", () => {
    for (const kind of FEEDBACK_KINDS) {
      const { url, truncated } = feedbackUrl({ kind, title: "t", description: "d" }, env);
      expect(url.startsWith("https://github.com/yul761/butler/issues/new?")).toBe(true);
      expect(params(url).get("template")).toBe(FEEDBACK_TEMPLATES[kind]);
      expect(truncated).toBe(false);
    }
  });

  it("prefills title, description and the environment", () => {
    const p = params(feedbackUrl({ kind: "bug", title: "  Crash   on start ", description: "It crashed.\nTwice." }, env).url);
    expect(p.get("title")).toBe("Crash on start");
    expect(p.get("description")).toBe("It crashed.\nTwice.");
    expect(p.get("environment")).toBe("- Butler: 4.0.0\n- OS: macOS 15.1.0 (darwin)\n- Architecture: arm64\n- Claude Code: 2.1.3");
  });

  it("leaves empty fields out so the template's own defaults stay", () => {
    const p = params(feedbackUrl({ kind: "idea", title: "", description: "  " }, env).url);
    expect(p.has("title")).toBe(false);
    expect(p.has("description")).toBe(false);
  });

  it("names the diagnostics file and the first-run step", () => {
    const p = params(feedbackUrl({ kind: "first-run", title: "", description: "", step: "hooks", diagnosticsFile: "butler-diagnostics-redacted-x.json" }, env).url);
    expect(p.get("step")).toBe("hooks");
    expect(p.get("diagnostics")).toContain("butler-diagnostics-redacted-x.json");
    expect(params(feedbackUrl({ kind: "bug", title: "", description: "", step: "hooks" }, env).url).has("step")).toBe(false);
  });

  it("cuts a long description to fit, on code-point boundaries, and says so", () => {
    const description = "卡住了😀".repeat(400);
    const { url, truncated } = feedbackUrl({ kind: "bug", title: "标题", description }, env);
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(FEEDBACK_URL_MAX);
    const got = params(url).get("description")!;
    expect(got.endsWith("…(truncated)")).toBe(true);
    expect(description.startsWith(got.replace(/\n\n…\(truncated\)$/, ""))).toBe(true);
    expect(got).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(params(url).get("title")).toBe("标题");
    // 已经尽量多放：再多一个字就超了。
    expect(url.length).toBeGreaterThan(FEEDBACK_URL_MAX - 60);
  });

  it("cuts the title too when the title alone is too long", () => {
    const { url, truncated } = feedbackUrl({ kind: "bug", title: "长".repeat(5000), description: "x".repeat(5000) }, env, 600);
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(600);
    expect(params(url).get("title")!.endsWith("…")).toBe(true);
    expect(params(url).has("description")).toBe(false);
    expect(params(url).get("environment")).toContain("Butler: 4.0.0");
  });

  it("isFeedbackKind", () => {
    expect(isFeedbackKind("bug")).toBe(true);
    expect(isFeedbackKind("question")).toBe(false);
    expect(isFeedbackKind(1)).toBe(false);
  });
});

describe("issue templates", () => {
  const dir = join(__dirname, "../../.github/ISSUE_TEMPLATE");
  const ids = (file: string) => [...readFileSync(join(dir, file), "utf8").matchAll(/^\s*id:\s*([\w-]+)\s*$/gm)].map((m) => m[1]);

  it("every template has the fields the link prefills, and only description is required", () => {
    for (const kind of FEEDBACK_KINDS) {
      const file = FEEDBACK_TEMPLATES[kind];
      const text = readFileSync(join(dir, file), "utf8");
      expect(ids(file), file).toEqual(expect.arrayContaining(["description", "environment", "diagnostics"]));
      if (kind === "first-run") expect(ids(file)).toContain("step");
      expect(text.match(/required:\s*true/g)?.length ?? 0, file).toBe(1);
    }
  });

  it("config.yml points questions at Discussions", () => {
    const text = readFileSync(join(dir, "config.yml"), "utf8");
    expect(text).toContain("https://github.com/yul761/butler/discussions");
  });
});
