import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspacePath = new URL(
  "../components/automation-workspace.tsx",
  import.meta.url,
);

test("workflow composer has one outer focus boundary", async () => {
  const source = await readFile(workspacePath, "utf8");

  assert.match(source, /focus-within:border-\[#d7aa2f\]/);
  assert.match(source, /focus-within:shadow-\[0_0_0_3px_rgba\(215,170,47,\.14\)\]/);
  assert.match(source, /workflow-composer flex items-center/);
  assert.match(source, /appearance-none border-0 bg-transparent/);
  assert.match(source, /focus:border-0 focus:outline-none focus:ring-0/);
  assert.match(source, /focus-visible:outline-none focus-visible:ring-0/);
  assert.doesNotMatch(source, /focus-within:ring-4/);
});

test("workflow canvas owns scrolling and does not clip the node stack", async () => {
  const source = await readFile(workspacePath, "utf8");

  assert.match(
    source,
    /workflow-canvas relative min-h-0 flex-1 overflow-y-auto/,
  );
  assert.match(source, /flex w-full max-w-\[420px\] flex-col items-stretch/);
  assert.match(source, /relative flex h-10 w-full items-center justify-center/);
  assert.doesNotMatch(source, /workflow-canvas relative h-\[44%\]/);
});

test("desktop inspector stays bounded and collapses below xl", async () => {
  const source = await readFile(workspacePath, "utf8");

  assert.match(source, /hidden w-\[288px\].*xl:flex 2xl:w-\[320px\]/);
  assert.match(source, /contentClassName="xl:hidden"/);
});
