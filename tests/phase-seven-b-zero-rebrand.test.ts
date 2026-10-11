import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const homepage = source("components/launch-home.tsx");
const layout = source("app/layout.tsx");
const proxy = source("lib/supabase/proxy.ts");
const login = source("app/login/page.tsx");
const manifest = source("app/manifest.ts");
const sitemap = source("app/sitemap.ts");
const publicForm = source("components/public-workflow-form.tsx");
const publicResult = source("app/f/[projectId]/result/page.tsx");
const dashboard = source("app/dashboard/layout.tsx");
const trustPages = ["privacy", "terms", "security", "data-use", "support"]
  .map((route) => source(`app/${route}/page.tsx`));

test("7B-0-1. root route is a public homepage and no longer redirects", () => {
  assert.doesNotMatch(homepage, /redirect\(/);
  assert.match(homepage, /From company goals/);
  assert.match(homepage, /to completed work/);
  assert.doesNotMatch(proxy, /pathname === "\/"/);
});

test("7B-0-2. homepage has truthful pilot and work-journey calls to action", () => {
  assert.match(homepage, /mailto:\$\{getSupportEmail\(\)\}/);
  assert.match(homepage, /href="#how-it-works"/);
  assert.match(login, /mode\?: string/);
  assert.match(login, /=== "signup" \? "signup"/);
});

test("7B-0-3. hero illustrates a reviewed work journey, not fabricated live outcomes", () => {
  for (const claim of ["COMPANY GOAL", "MY DAY", "Do with AI", "Illustrative workspace"]) assert.match(homepage, new RegExp(claim));
  assert.match(homepage, /People approve the plan and review the result/);
});

test("7B-0-4. connector availability and beta status are explicit", () => {
  assert.match(homepage, /Pilot access depends on your connected accounts, granted permissions and supported actions/);
  assert.match(homepage, /confirm available actions and resources together during pilot setup/);
  assert.match(homepage, /Connections do not grant access to every resource/);
});

test("7B-0-5. homepage contains no fabricated proof or inflated support claims", () => {
  assert.doesNotMatch(homepage, /testimonial|trusted by|customer count|user count|revenue|Product Hunt|20\+|thousands of integrations|connect everything|works with all your apps|replace Zapier/i);
});

test("7B-0-6. reliability and security claims remain bounded", () => {
  for (const claim of ["Approval before action", "Sources, not invented certainty", "provider-confirmed outcomes", "private Ask conversations", "unfinished employee drafts"]) {
    assert.match(homepage, new RegExp(claim, "i"));
  }
  assert.doesNotMatch(homepage, /SOC 2|ISO 27001|HIPAA|bank-grade|military-grade|100% secure/i);
});

test("7B-0-7. canonical metadata, manifest, sitemap, and OG identity use the production CrazyLoops domain", () => {
  assert.match(layout, /metadataBase: new URL\("https:\/\/www\.crazy-loops\.com"\)/);
  assert.match(homepage, /https:\/\/www\.crazy-loops\.com\//);
  assert.match(layout, /siteName: "CrazyLoops"/);
  assert.match(manifest, /name: "CrazyLoops"/);
  assert.match(sitemap, /https:\/\/www\.crazy-loops\.com/);
  assert.doesNotMatch([layout, homepage, manifest, sitemap].join("\n"), /flow-mind-beta\.vercel\.app/i);
});

test("7B-0-8. canonical public trust routes are present and branded", () => {
  for (const [index, route] of ["privacy", "terms", "security", "data-use", "support"].entries()) {
    assert.match(trustPages[index], new RegExp(`https://www\\.crazy-loops\\.com/${route}`));
    assert.match(trustPages[index], /CrazyLoops/);
    assert.doesNotMatch(trustPages[index], /FlowMind|FlowPilot/);
  }
});

test("7B-0-9. active customer surfaces contain no previous product name", () => {
  const activeSurfaces = [homepage, layout, login, publicForm, publicResult, dashboard, ...trustPages].join("\n");
  assert.doesNotMatch(activeSurfaces, /FlowMind|FlowPilot|flow-mind|flowpilot/);
});

test("7B-0-10. hosted forms and result truthfulness use CrazyLoops", () => {
  assert.match(publicForm, /Powered by CrazyLoops/);
  assert.match(publicResult, /stored in CrazyLoops/);
  assert.match(publicResult, /CrazyLoops secure automation/);
});

test("7B-0-11. homepage navigation is semantic and mobile-accessible without a JS dependency", () => {
  assert.match(homepage, /<header/);
  assert.match(homepage, /<main/);
  assert.match(homepage, /<footer/);
  assert.match(homepage, /aria-label="Main navigation"/);
  assert.match(homepage, /Skip to content/);
  assert.doesNotMatch(homepage, /"use client"/);
});

test("7B-0-12. Google data disclosure links to the canonical data-use page", () => {
  assert.match(homepage, /granted permissions and supported actions/);
  assert.match(homepage, /href="\/data-use"/);
  assert.match(trustPages[3], /Google tokens and disconnection/);
  assert.match(trustPages[3], /not used for unrelated advertising/);
});

test("7B-0-13. premium homepage uses the final outcome-first copy hierarchy", () => {
  const orderedClaims = [
    'label: "For managers"',
    'label: "For employees"',
    'label: "AI-assisted execution"',
    'label: "Repeated work"',
    "BUILT AROUND HUMAN JUDGEMENT",
    "CONNECTED TO YOUR EVERYDAY WORK",
    "THE FIRST-CUSTOMER PILOT",
  ];
  let previous = -1;
  for (const claim of orderedClaims) {
    const current = homepage.indexOf(claim);
    assert.ok(current > previous, `${claim} should appear in the supplied narrative order`);
    previous = current;
  }
});
