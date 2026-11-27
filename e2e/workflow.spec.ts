import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, openSettingsTab, terminalText, test, type Sandbox } from "./fixtures";

/**
 * BTL-273：设置 › 工作流程。没设时说照旧；加一层全局、选「严格」、保存，存进 workflow_layers；清掉又回到照旧。
 * 「用 Claude 设置」打开 Shipherd 总控、跳到总控页，终端就是它。
 */

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
function layers(s: Sandbox): { scope_kind: string; workflow: string }[] {
  const db = new DatabaseSync(join(s.shipherdHome, "app.db"), { readOnly: true });
  try {
    return db.prepare("SELECT scope_kind, workflow FROM workflow_layers ORDER BY id").all() as { scope_kind: string; workflow: string }[];
  } finally {
    db.close();
  }
}

test("adds, saves and clears a global workflow layer", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await openSettingsTab(page, "workflow");
  const box = page.getByTestId("workflow-settings");
  await expect(box).toContainText(S.workflow.none);

  // 种类默认是「全局」：直接加，编辑器从「快速」开始；换成「严格」再保存。
  await page.getByTestId("workflow-add").click();
  const editor = page.getByTestId("workflow-editor");
  await expect(editor.getByTestId("workflow-preset-fast")).toHaveClass(/active/);
  await editor.getByTestId("workflow-preset-strict").click();
  await editor.getByTestId("workflow-save").click();
  await expect(box.getByRole("status")).toHaveText(S.workflow.saved);
  const layer = box.getByTestId("workflow-layer");
  await expect(layer).toHaveAttribute("data-scope", "global");
  await expect(layer.locator('[data-step="pre_review"]')).toHaveCount(1);
  await expect.poll(() => layers(s).map((l) => l.scope_kind)).toEqual(["global"]);
  expect(JSON.parse(layers(s)[0].workflow).steps.map((x: { id: string }) => x.id)).toContain("bot_review");

  // 全局已经设了，「加一层」只能选别的种类。
  await expect(page.getByTestId("workflow-add")).toBeDisabled();

  await box.getByTestId("workflow-clear").click();
  await expect(box).toContainText(S.workflow.none);
  await expect.poll(() => layers(s)).toEqual([]);
});

test("set it up with Claude opens the Shipherd coordinator and lands on its terminal", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await openSettingsTab(page, "workflow");
  await page.getByTestId("workflow-ask-claude").click();
  const shipherd = page.locator(".shipherd-page");
  await expect(shipherd).toHaveCount(1);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await expect(shipherd.locator(".control-left .terminal-wrap")).toHaveCount(1);
  expect(fakeLog(s).match(/ interactive new /g)).toHaveLength(1);
});
