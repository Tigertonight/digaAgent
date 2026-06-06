import { test, expect } from "./fixtures";

test("workbench: Overview 作为右侧 root 并支持折叠分组", async ({
  bootedPage: page,
}) => {
  await page.getByLabel("Workbench 面板").click();

  await expect(page.getByTestId("workbench-overview")).toBeVisible();
  await expect(page.getByTestId("workbench-section-progress")).toBeVisible();
  await expect(page.getByTestId("workbench-section-outputs")).toBeVisible();
  await expect(page.getByTestId("workbench-section-files")).toBeVisible();
  await expect(page.getByTestId("workbench-section-context")).toBeVisible();
  await expect(page.getByTestId("workbench-section-browser")).toBeVisible();

  await page.getByTestId("workbench-section-outputs-toggle").click();
  await expect(page.getByText("0 个产物")).toBeHidden();
  await page.getByTestId("workbench-section-outputs-toggle").click();
  await expect(page.getByText("0 个产物")).toBeVisible();

  await page.getByTestId("workbench-section-context-action").click();
  await expect(page.getByTestId("workbench-context-detail")).toBeVisible();
  await expect(page.getByText("sessionId")).toBeVisible();

  await page.getByLabel("返回 Overview").click();
  await expect(page.getByTestId("workbench-overview")).toBeVisible();

  await page.getByTestId("workbench-section-progress-action").click();
  await expect(page.getByTestId("workbench-progress-detail")).toBeVisible();
  await expect(page.getByText("暂无进度")).toBeVisible();

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByTestId("workbench-sidebar")).toBeHidden();
});
