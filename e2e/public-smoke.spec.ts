import { expect, test } from "@playwright/test";

test("login, recovery strategy, and legal links render without exposing errors", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /privacy/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /support/i })).toBeVisible();
  await expect(page.getByText(/forgot|recover/i).first()).toBeVisible();
});

test("protected application routes redirect anonymous browsers", async ({ page }) => {
  for (const path of ["/dashboard", "/settings", "/settings/usage", "/settings/export"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
});

test("invalid public form fails safely at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const response = await page.goto("/f/00000000-0000-4000-8000-000000000000");
  expect(response?.status()).toBe(404);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBe(0);
});

test("production security headers remain present", async ({ request }) => {
  const response = await request.get("/login");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});
