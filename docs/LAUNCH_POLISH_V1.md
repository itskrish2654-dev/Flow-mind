# Launch polish v1

Scope: accepted RC `2723fe9e1ba3f897ee9858a58f6e23de84804efe`, isolated
`codex/work-os-launch-polish-v1`, staging only. No migration, provider model,
connector availability, approval contract, or customer-production changes.

## Performance method

Controlled Chromium browser, staging, disposable company created via normal
signup/invitation UI; one real AI plan, three assigned tasks, one synthetic
company document. Desktop 1440×1000, employee mobile 390×844. Three direct
navigations per route; measure navigation start until the actual page heading
is visible (not the loading fallback). Same fixture for before and after.
These are lab observations, not field Core Web Vitals or a latency guarantee.
Network-idle waiting and screenshots are excluded from ready-time measurements.

Before median ready times: My Day 3485 ms; Team work 2556 ms; Goals 2774 ms;
Goal detail 3156 ms; Ask 1925 ms; Automations 1571 ms; Knowledge 1801 ms;
owner onboarding 3303 ms; employee My Day 2843 ms. Employee workbench single
sample 3795 ms. Actual AI-plan generation 9609 ms; workbench AI draft 13404 ms.
Homepage: desktop LCP 3144 ms, mobile LCP 1908 ms, both observed CLS 0.

Verified source causes: repeated `getAuthenticatedContext()` calls each performed
an auth lookup plus trusted membership RPC, even within one server render.
The client shell also eagerly called workflow readiness on unrelated work routes.
Request-scoped React memoization deduplicates a render; it is NOT persistent
user/workspace caching. The advanced-workflow sidebar fetches only on workflow
routes. Role-aware navigation is presentation only; destinations retain their
existing authorization. Loading boundaries contain no saved user content.

AI provider latency remains external. Pending labels report only actual pending
work, never fabricated stages or percentages. Interrupted operations tell the
user to check persisted state before resubmission.

## Homepage and contact

Server-rendered Work OS narrative replaces the old public interactive demo on
the homepage; the demo implementation and advanced workflow builder are retained.
The product illustration is explicitly labelled illustrative, not a live result.
All pilot CTAs use the existing validated support email and an encoded `mailto`
enquiry. The page explicitly says it opens an email app: no false submission
confirmation, availability, payment, or automatic delivery claim. This creates
no public form endpoint needing a new anti-spam policy. Email delivery itself
depends on the visitor's email client; browser acceptance verifies the handoff.

## Owner/legal review required before customer-data onboarding

Do not treat these flags as legal approval or rewrite policy promises casually:

- `app/privacy/page.tsx`: data categories and AI-use statement still focus on
  workflows. Review Goals, membership, assignments, employee AI drafts/final
  deliverables, Ask, Knowledge, Activity, analytics and connected-app retrieval.
- `app/terms/page.tsx`: review company administration, employee responsibilities,
  human approval of AI output/actions, pilot limitations and service obligations.
- `app/security/page.tsx`: clarify the shared-company/private-employee boundary,
  manager access to final results, approval execution and current deployment
  posture. Do not imply self-hosting, certification or absolute security.
- `app/data-use/page.tsx`: “only when a workflow contains an enabled AI step” is
  outdated for Ask, Goal planning and Do with AI. Review exact provider data flow,
  authorised sources, scope union, purpose limitation, retention/deletion and
  subprocessors. Long-term company audit retention remains an owner policy choice.

All four documents require owner/legal approval before real customer content is
onboarded. This polish gate flags the gap; it does not invent binding policies.
