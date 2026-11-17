import { describe, expect, it } from "vitest";
import { skillCategory, slashSkill } from "./pr-stages";

describe("skillCategory", () => {
  it("归类设计类 skill", () => {
    for (const n of ["brainstorming", "superpowers:brainstorming", "writing-plans"]) {
      expect(skillCategory(n)).toBe("design");
    }
  });
  it("归类 review 类 skill", () => {
    for (const n of ["code-review", "superpowers:requesting-code-review", "simplify", "security-review"]) {
      expect(skillCategory(n)).toBe("review");
    }
  });
  it("skillCategory maps subagent-driven-development, receiving-code-review and agent:* to review", () => {
    for (const n of ["subagent-driven-development", "superpowers:receiving-code-review", "agent:Review task 3", "agent:code-reviewer"]) {
      expect(skillCategory(n)).toBe("review");
    }
  });
  it("其他返回 null", () => {
    expect(skillCategory("handoff")).toBeNull();
    expect(skillCategory("")).toBeNull();
  });
  it("大小写不敏感", () => {
    expect(skillCategory("Code-Review")).toBe("review");
  });
});

describe("slashSkill", () => {
  it("取开头的 /name，去掉参数", () => {
    expect(slashSkill("/code-review high")).toBe("code-review");
    expect(slashSkill("  /superpowers:brainstorming\n做个东西")).toBe("superpowers:brainstorming");
  });
  it("不在开头或只有斜杠返回 null", () => {
    expect(slashSkill("帮我 /code-review")).toBeNull();
    expect(slashSkill("/")).toBeNull();
  });
});
