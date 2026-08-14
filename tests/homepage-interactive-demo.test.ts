import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { planHomepageDemo } from "../lib/homepage-demo";
import {
  HOMEPAGE_DEMO_DRAFT_TTL_SECONDS,
  openHomepageDemoDraft,
  sealHomepageDemoDraft,
} from "../lib/security/homepage-demo-draft";

const TEST_KEY = Buffer.alloc(32, 37).toString("base64");

test("homepage default prompt previews the truthful Request → AI → PDF → Store path", () => {
  const result = planHomepageDemo(
    "When a new request comes in, summarize it, create a PDF and save the result.",
  );
  assert.equal(result.status, "supported");
  if (result.status !== "supported") return;
  assert.deepEqual(result.steps.map(({ label }) => label), ["Request", "AI", "PDF", "Store"]);
  assert.equal(result.message, "4 steps. Nothing to wire together.");
});

test("homepage planner rejects TikTok and Salesforce without fabricated steps", () => {
  const result = planHomepageDemo(
    "When a TikTok comment arrives, update Salesforce.",
  );
  assert.equal(result.status, "unsupported");
  if (result.status !== "unsupported") return;
  assert.equal(result.title, "PART OF THIS LOOP ISN'T AVAILABLE YET.");
  assert.equal(result.message, "TikTok and Salesforce aren't supported yet.");
});

test("homepage planner requests one useful clarification and then stops the public conversation", () => {
  const first = planHomepageDemo("Summarize incoming requests");
  assert.equal(first.status, "clarification");
  if (first.status !== "clarification") return;
  assert.equal(first.canClarify, true);
  assert.match(first.question, /where/i);

  const second = planHomepageDemo("Summarize incoming requests", "I am not sure", 1);
  assert.equal(second.status, "clarification");
  if (second.status !== "clarification") return;
  assert.equal(second.canClarify, false);
});

test("homepage draft is opaque, authenticated, short-lived, and tamper resistant", () => {
  const prompt = "Collect a request in a form and store it in CrazyLoops";
  const now = Date.parse("2026-08-14T10:00:00.000Z");
  const token = sealHomepageDemoDraft(prompt, now, TEST_KEY);
  assert.equal(token.includes(prompt), false);
  assert.equal(openHomepageDemoDraft(token, now + 1_000, TEST_KEY), prompt);
  assert.equal(
    openHomepageDemoDraft(token, now + HOMEPAGE_DEMO_DRAFT_TTL_SECONDS * 1_000 + 1, TEST_KEY),
    null,
  );
  assert.equal(openHomepageDemoDraft(`${token.slice(0, -1)}A`, now, TEST_KEY), null);
});

test("homepage preview server action has no workflow execution or connector side effects", async () => {
  const source = await readFile(new URL("../app/actions/homepage-demo.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "runTestWorkflow",
    "executeWorkflow",
    "generatePdf",
    "saveWorkflow",
    "createWorkflow",
    "connector-execution",
  ]) {
    assert.equal(source.includes(forbidden), false, `unexpected side-effect path: ${forbidden}`);
  }
  assert.match(source, /enforceRateLimit/);
  assert.match(source, /2_000/);
});

test("homepage analytics uses the required privacy-safe event vocabulary", async () => {
  const source = await readFile(new URL("../lib/observability.ts", import.meta.url), "utf8");
  for (const event of [
    "demo_viewed",
    "demo_input_focused",
    "demo_example_clicked",
    "demo_submitted",
    "demo_supported",
    "demo_unsupported",
    "demo_signup_clicked",
  ]) {
    assert.match(source, new RegExp(`\\"${event}\\"`));
  }
  assert.match(source, /PRIVATE_METADATA_KEY[\s\S]*prompt/);
});

test("homepage demo makes editing, guide, truthful result and state labels explicit", async () => {
  const source = await readFile(new URL("../components/homepage-workflow-demo.tsx", import.meta.url), "utf8");
  for (const text of [
    "Try it — type what should happen",
    "Describe something you do repeatedly...",
    "Build the loop",
    "Build my loop",
    "Understanding…",
    "Loop ready ✓",
    "Build it for real",
    "Built from what you just typed.",
    "Nothing runs until you choose to build it.",
    "No account needed.",
  ]) {
    assert.ok(source.includes(text), `missing demo copy: ${text}`);
  }
  for (const category of ["Trigger", "AI", "Create", "Store"]) {
    assert.match(source, new RegExp(`return \\"${category}\\"`));
  }
  assert.match(source, /sessionStorage/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /prefers-reduced-motion/);
});

test("demo quick examples populate only and never submit implicitly", async () => {
  const source = await readFile(new URL("../components/homepage-workflow-demo.tsx", import.meta.url), "utf8");
  assert.match(source, /function chooseExample\(example: string\)[\s\S]*reset\(example\)/);
  assert.doesNotMatch(source, /function chooseExample\(example: string\)[\s\S]{0,180}buildLoop/);
});

test("demo textarea focus uses a neutral treatment without a yellow glow", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.landing-demo-prompt-editable textarea:focus-visible\s*\{[^}]*box-shadow:\s*none;/,
  );
  assert.doesNotMatch(
    css,
    /\.landing-demo-prompt-editable textarea:focus-visible\s*\{[^}]*rgba\(241,\s*212,\s*47/,
  );
});
