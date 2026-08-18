import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("successful public-form results are not a navigation dead end", async () => {
  const [page, navigation] = await Promise.all([
    readFile("app/f/[projectId]/result/page.tsx", "utf8"),
    readFile("app/f/[projectId]/result/result-navigation.tsx", "utf8"),
  ]);

  assert.match(page, /ResultNavigation formHref=\{formHref\}/);
  assert.match(navigation, /Submit another response/);
  assert.match(navigation, /CrazyLoops home/);
  assert.match(navigation, /AUTO_RETURN_SECONDS = 12/);
  assert.match(navigation, /router\.replace\(formHref\)/);
  assert.match(navigation, /Stay on this page/);
  assert.match(navigation, /Automatic return paused/);
});

test("failed public-form results retain retry and home navigation", async () => {
  const page = await readFile("app/f/[projectId]/result/page.tsx", "utf8");
  assert.match(page, /Try again/);
  assert.match(page, /CrazyLoops home/);
  assert.match(page, /href=\{formHref\}/);
});
