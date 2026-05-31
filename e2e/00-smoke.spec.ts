import { test, expect } from "./fixtures";

test("smoke: ChatApp 挂载成功", async ({ bootedPage: page }) => {
  await expect(page.getByText("Diga Agent").first()).toBeVisible();
  // 输入框存在
  const editor = page.locator("textarea, [contenteditable]").first();
  await expect(editor).toBeVisible();
});
