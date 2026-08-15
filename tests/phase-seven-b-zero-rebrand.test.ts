import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const homepage = source("app/page.tsx");
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
  assert.match(homepage, /Run the work\./);
  assert.match(homepage, /Not every task\./);
  assert.doesNotMatch(proxy, /pathname === "\/"/);
});

test("7B-0-2. homepage has truthful signup and product-demo calls to action", () => {
  assert.match(homepage, /href="\/login\?mode=signup"/);
  assert.match(homepage, /href="#product"/);
  assert.match(login, /mode\?: string/);
  assert.match(login, /=== "signup" \? "signup"/);
});

test("7B-0-3. hero demonstrates only production-supported capabilities", () => {
  for (const claim of ["Request", "AI", "PDF", "Store"]) assert.match(homepage, new RegExp(claim));
  const hero = homepage.slice(homepage.indexOf("function ProductDemo"), homepage.indexOf("export default function HomePage"));
  assert.doesNotMatch(hero, /Slack|Stripe|Salesforce|Gmail|Google Sheets/);
});

test("7B-0-4. connector availability and beta status are explicit", () => {
  assert.match(homepage, />Available</);
  assert.match(homepage, /Webhook/);
  assert.match(homepage, /HTTP JSON/);
  assert.match(homepage, />Beta</);
  assert.ok((homepage.match(/Google approval pending/g) ?? []).length >= 3);
  assert.match(homepage, /More connections appear only after they pass production reliability testing/);
});

test("7B-0-5. homepage contains no fabricated proof or inflated support claims", () => {
  assert.doesNotMatch(homepage, /testimonial|trusted by|customer count|user count|revenue|Product Hunt|20\+|thousands of integrations|connect everything|works with all your apps|replace Zapier/i);
});

test("7B-0-6. reliability and security claims remain bounded", () => {
  for (const claim of ["version", "Retry-safe", "step-by-step status", "Private documents", "Account isolation", "Protected connections"]) {
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
  assert.match(homepage, /<details className="landing-mobile-menu/);
  assert.match(homepage, /aria-label="Open navigation menu"/);
});

test("7B-0-12. Google data disclosure links to the canonical data-use page", () => {
  assert.match(homepage, /requests only the permissions required/);
  assert.match(homepage, /href="\/data-use"/);
  assert.match(trustPages[3], /Google tokens and disconnection/);
  assert.match(trustPages[3], /not used for unrelated advertising/);
});

test("7B-0-13. premium homepage uses the final outcome-first copy hierarchy", () => {
  const orderedClaims = [
    "Run the work.",
    "You already know what should happen.",
    "You don’t start with boxes.",
    "Simple to build.",
    "Stop being the connection between your tools.",
    "What you can build today",
    "The loop is the product.",
    "Describe it once.",
  ];
  let previous = -1;
  for (const claim of orderedClaims) {
    const current = homepage.indexOf(claim);
    assert.ok(current > previous, `${claim} should appear in the supplied narrative order`);
    previous = current;
  }
});
