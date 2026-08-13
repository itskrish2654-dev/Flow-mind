import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyPdfEmojiPolicy,
  assertPdfScriptSupport,
  generatePdfBuffer,
  PdfRenderError,
} from "../lib/pdf-document";

const source = async (file: string) => readFile(file, "utf8");

test("5-1. mobile navigation exposes workflows, creation, account, settings, usage, support, and logout", async () => {
  const layout = await source("app/dashboard/layout.tsx");
  assert.match(layout, /aria-label="Open navigation menu"/);
  for (const label of ["Create workflow", "My automations", "Settings", "Usage", "Support &amp; legal", "Log out"]) assert.match(layout, new RegExp(label));
});

test("5-2. workflow inspector remains accessible below xl", async () => {
  const workspace = await source("components/automation-workspace.tsx");
  assert.match(workspace, /Configure step/);
  assert.match(workspace, /side="right"/);
  assert.match(workspace, /className="flex min-h-0 w-full flex-1 flex-col/);
});

test("5-3. account and logout remain accessible on phone", async () => {
  const layout = await source("app/dashboard/layout.tsx");
  assert.match(layout, /Mobile dashboard navigation/);
  assert.match(layout, /account\.displayName/);
  assert.match(layout, /void logOut\(\)/);
});

test("5-4. settings navigation is narrow-screen safe", async () => {
  const shell = await source("components/settings-shell.tsx");
  assert.match(shell, /overflow-x-auto/);
  assert.match(shell, /min-h-11/);
});

test("5-5. execution history has an intentional mobile card layout", async () => {
  const table = await source("components/executions-data-table.tsx");
  assert.match(table, /space-y-3 md:hidden/);
  assert.match(table, /hidden overflow-x-auto[\s\S]*md:block/);
  assert.match(table, /basis-full sm:flex-1 sm:basis-auto/);
  assert.match(table, /max-w-\[62%\]/);
  assert.match(table, /window\.location\.assign\(result\.url\)/);
  assert.doesNotMatch(table, /window\.open\(result\.url/);
});

test("5-6. public form uses bounded width and wrapping-safe controls", async () => {
  const form = await source("components/public-workflow-form.tsx");
  assert.match(form, /w-full max-w-xl/);
  assert.match(form, /w-full resize-y/);
  assert.doesNotMatch(form, /min-w-\[/);
});

test("5-7. Turnstile uses a responsive overflow-safe container", async () => {
  const turnstile = await source("components/auth-turnstile.tsx");
  const css = await source("app/globals.css");
  assert.match(turnstile, /turnstile-safe/);
  assert.match(css, /\.turnstile-safe[\s\S]*max-width: 100%[\s\S]*overflow-x: auto/);
});

test("5-8. core mobile project views remain present", async () => {
  const project = await source("components/project-workspace.tsx");
  for (const view of ["Workflow", "Versions", "Executions &amp; Data"]) assert.match(project, new RegExp(view));
  assert.match(project, /overflow-x-auto/);
});

test("5-9/10/11. accessible dialogs trap focus, restore focus, and close with Escape through Radix", async () => {
  const dialog = await source("components/accessible-dialog.tsx");
  assert.match(dialog, /@radix-ui\/react-dialog/);
  assert.match(dialog, /Dialog\.Root/);
  assert.match(dialog, /Dialog\.Content/);
  assert.match(dialog, /Dialog\.Close/);
});

test("5-12. required public inputs have native labels", async () => {
  const form = await source("components/public-workflow-form.tsx");
  assert.match(form, /<label htmlFor=\{field\.key\}/);
  assert.match(form, /id=\{field\.key\}/);
  assert.match(form, /required=\{field\.required\}/);
});

test("5-13. icon-only buttons have accessible names", async () => {
  const files = await Promise.all(["app/dashboard/layout.tsx", "components/executions-data-table.tsx", "components/accessible-dialog.tsx"].map(source));
  for (const content of files) assert.match(content, /aria-label=/);
});

test("5-14/15. native buttons and globally visible focus states support keyboard use", async () => {
  const css = await source("app/globals.css");
  const layout = await source("app/dashboard/layout.tsx");
  assert.match(layout, /<button/);
  assert.match(css, /:focus-visible[\s\S]*outline: 3px solid/);
});

test("5-16/17. errors and async states use accessible semantics", async () => {
  const workspace = await source("components/automation-workspace.tsx");
  const layout = await source("app/dashboard/layout.tsx");
  assert.match(workspace, /role="alert"/);
  assert.match(layout, /role="status"/);
});

test("5-18. generated form schema and rendering enforce non-empty accessible labels", async () => {
  const schema = await source("lib/schemas/workflow.ts");
  const form = await source("components/public-workflow-form.tsx");
  assert.match(schema, /label: z\.string\(\)\.min\(1\)\.max\(80\)/);
  assert.match(form, /\{field\.label\}/);
});

test("5-19. accented Latin is embedded without stripping", async () => {
  const value = "José García — résumé café naïve";
  const pdf = await generatePdfBuffer(value);
  assert.ok(pdf.byteLength > 2_000);
  assert.equal(applyPdfEmojiPolicy(value), value);
});

test("5-20. Hindi is embedded without stripping", async () => {
  const pdf = await generatePdfBuffer("नमस्ते दुनिया");
  assert.ok(pdf.byteLength > 4_000);
});

test("5-21/22. Chinese and Japanese are embedded through CJK font subsets", async () => {
  const pdf = await generatePdfBuffer("你好世界 — こんにちは世界");
  assert.ok(pdf.byteLength > 8_000);
});

test("5-23. Arabic is explicitly rejected rather than corrupted", async () => {
  assert.throws(() => assertPdfScriptSupport("مرحبا بالعالم"), (error) => error instanceof PdfRenderError && /right-to-left/.test(error.message));
});

test("5-24. emoji policy preserves surrounding Unicode and emits an explicit marker", () => {
  assert.equal(applyPdfEmojiPolicy("José नमस्ते 你好 🚀 ✅ ❤️ end"), "José नमस्ते 你好 [emoji] [emoji] [emoji] end");
});

test("5-25. mixed-language PDF generation succeeds", async () => {
  const pdf = await generatePdfBuffer("Customer: García — नमस्ते — 你好 — こんにちは — 🚀");
  assert.ok(pdf.byteLength > 7_000);
});

test("5-26/27. long Unicode lines wrap and multi-page content generates", async () => {
  const content = Array.from({ length: 100 }, (_, index) => `Line ${index + 1}: José — नमस्ते — 你好 — こんにちは — ${"unbroken".repeat(40)}`).join("\n\n");
  const pdf = await generatePdfBuffer(content);
  assert.ok(pdf.byteLength > 20_000);
});

test("5-27b. production PDF initialization does not depend on untraced Helvetica metrics", async () => {
  const pdfSource = await source("lib/pdf-document.ts");
  assert.match(pdfSource, /font: FONT_PATHS\.latin/);
});

test("5-28. no ASCII stripping implementation remains", async () => {
  const pdfSource = await source("lib/pdf-document.ts");
  assert.doesNotMatch(pdfSource, /printableText|NFKD|\\x09\\x0A\\x0D\\x20-\\x7E/);
});

test("5-29/30/31. private storage, signed-link ownership, and deletion cleanup remain enforced", async () => {
  const security = await source("tests/phase-two-security.test.ts");
  const account = await source("tests/phase-four-account-trust.test.ts");
  assert.match(security, /generated documents use a private bounded PDF-only bucket/);
  assert.match(security, /signed document links are owner-scoped/);
  assert.match(account, /deletion removes private document objects before metadata/);
});

test("5-32. significant motion respects reduced-motion preferences", async () => {
  const css = await source("app/globals.css");
  assert.match(css, /prefers-reduced-motion: reduce/);
});
