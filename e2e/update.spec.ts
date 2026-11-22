import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, ghCalls, openSettingsTab, test, unsupportedGhCalls, type FakeGhFixture } from "./fixtures";

// 更新提示（BTL-253）：假 gh 给 releases/latest 的结果。Butler 只经 gh 查，不自己发 HTTP 请求，只提示不下载。
const release = (tag: string, body = "## Fixes\n- Faster startup") => ({
  tag_name: tag, html_url: `https://github.com/yul761/butler/releases/tag/${tag}`, body, draft: false, prerelease: false, published_at: "2026-11-20T08:00:00Z",
});
const withRelease = (r: FakeGhFixture["release"]): FakeGhFixture => ({ branches: {}, prs: {}, ...(r ? { release: r } : {}) });
const releaseCalls = (calls: string[][]) => calls.filter((a) => a[0] === "api" && /\/releases\/latest$/.test(a[1] ?? ""));

test.describe("update notice", () => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");

  test("shows a newer release at the top; skipping it hides it, also after a restart, until a newer one comes out", async ({ makeSandbox, launch }) => {
    const s = makeSandbox({ gh: withRelease(release("v99.0.0")) });
    const first = await launch(s);
    const page = first.page;
    await completeWizard(page, s);

    const banner = page.getByTestId("update-banner");
    await expect(banner).toContainText(S.update.available("99.0.0"), { timeout: 30_000 });
    // 说明默认收起，展开是纯文本。
    const notes = banner.getByTestId("update-notes");
    await expect(notes.locator("pre")).toBeHidden();
    await notes.locator("summary").click();
    await expect(notes.locator("pre")).toContainText("- Faster startup");
    expect(releaseCalls(ghCalls(s))).toHaveLength(1);

    await banner.getByTestId("update-skip").click();
    await expect(banner).toBeHidden();

    // 审计里记着这次查询。
    await page.locator(".sidebar").getByRole("button", { name: S.audit, exact: true }).click();
    await expect(page.getByTestId("external-audit").locator("tbody tr").first()).toContainText(S.update.auditKind);

    // 重启：24 小时内不再查，跳过的版本也不再提示。
    const probes = () => ghCalls(s).filter((a) => a[0] === "--version").length;
    const before = probes();
    await first.app.close();
    const second = await launch(s);
    // 更新检查在 gh 探测完之后才开始：等到这次启动的探测出现，再留一点时间给它（本该什么都不做）。
    await expect.poll(probes, { timeout: 30_000 }).toBeGreaterThan(before);
    await second.page.waitForTimeout(2000);
    await expect(second.page.getByTestId("update-banner")).toBeHidden();
    expect(releaseCalls(ghCalls(s))).toHaveLength(1);

    // 出了更高的版本：手动检查马上查到，提示条又出来。
    s.setGh(withRelease(release("v99.1.0")));
    await openSettingsTab(second.page, "about");
    await second.page.getByTestId("update-check-now").click();
    await expect(second.page.getByTestId("update-check-result")).toHaveText(S.update.resultAvailable("99.1.0"));
    await expect(second.page.getByTestId("update-banner")).toContainText(S.update.available("99.1.0"));
    // 关闭只管这一次运行。
    await second.page.getByTestId("update-close").click();
    await expect(second.page.getByTestId("update-banner")).toBeHidden();
    expect(unsupportedGhCalls(s)).toEqual([]);
  });

  test("a manual check says why it could not check, and when Butler is up to date", async ({ makeSandbox, launch }) => {
    const s = makeSandbox({ gh: withRelease(undefined) });
    const { page } = await launch(s);
    await completeWizard(page, s);
    await openSettingsTab(page, "about");
    const current = (await page.getByTestId("about-version").textContent())!.trim();

    // 还没发布过 release（假 gh 回 HTTP 404）：说原因，不弹东西，没有提示条。
    await page.getByTestId("update-check-now").click();
    await expect(page.getByTestId("update-check-result")).toContainText(S.update.resultFailed + S.update.reasons.no_release);
    await expect(page.getByTestId("update-banner")).toBeHidden();

    s.setGh(withRelease(release(`v${current}`)));
    await page.getByTestId("update-check-now").click();
    await expect(page.getByTestId("update-check-result")).toHaveText(S.update.resultLatest(current, current));

    // 预发布版本不算新版本。
    s.setGh(withRelease({ ...release("v999.0.0-rc.1"), prerelease: true }));
    await page.getByTestId("update-check-now").click();
    await expect(page.getByTestId("update-check-result")).toHaveText(S.update.resultLatest(current, "999.0.0-rc.1"));
    await expect(page.getByTestId("update-banner")).toBeHidden();

    // 关掉开关：关于页提示自动检查关了，手动检查照样能用。
    await openSettingsTab(page, "basic");
    // 受控的复选框：保存完才变，所以点一下再等它变。
    const sw = page.getByTestId("setting-updateCheckEnabled");
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(sw).not.toBeChecked();
    await openSettingsTab(page, "about");
    await expect(page.getByTestId("settings-about")).toContainText(S.update.autoOff);
    expect(unsupportedGhCalls(s)).toEqual([]);
  });
});
