import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

const storageState = process.env.E2E_STORAGE_STATE;
test.use({ storageState: storageState && existsSync(storageState) ? storageState : undefined });
test.skip(!storageState || !existsSync(storageState), "Provide a CAPTCHA-created disposable authenticated storage state.");

test("authenticated workflow, version, execution, and settings smoke", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText(/my automations/i)).toBeVisible();
  await page.getByPlaceholder(/describe the automation/i).fill(
    "Collect customer feedback in a public form, summarize it with AI, and store it in FlowMind",
  );
  await page.getByRole("button", { name: /generate workflow/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: /versions/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /executions & data/i })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.goto("/settings/usage");
  await expect(page.getByRole("heading", { name: /usage and limits/i })).toBeVisible();
});

