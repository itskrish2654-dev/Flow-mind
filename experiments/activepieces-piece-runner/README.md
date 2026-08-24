# Activepieces piece-in-runner feasibility spike

This directory is an isolated, non-production experiment. It is intentionally
not registered in the CrazyLoops capability registry, connector registry,
planner, user interface, deployment routes, or Connector Runner allowlist.

## Pinned upstream inputs

- Activepieces stable release: `0.88.3`
- Release commit: `54babcf9b3c6079125042134e2f70c7ce0f97a6a`
- HubSpot package: `@activepieces/piece-hubspot@0.8.10`
- Package source commit reported by npm: `e7e44d4ef9a2a2bcec8cb611eb63af5df2ba019e`
- npm integrity: `sha512-P3svTd/XaaPhYfsOSz6YpgdfNcARRawqAddBGtJUxW/Grbc5InTdsvddlgSdyQtJxH+3UpxrKAR1VjlGJ4hfNA==`
- Package source location: `packages/pieces/community/hubspot`
- Source license: MIT Expat because the piece is outside Activepieces' `packages/ee` tree

The npm package is a pre-bundled artifact. Its published `package.json` has no
runtime dependency or license field, while the corresponding official source
declares framework/common packages, `@hubspot/api-client@12.0.1`, and
`dayjs@1.11.9`. No enterprise package is required by the HubSpot source.

## Experiment boundary

The allowlist maps only `hubspot.get_contact@1` to the exact pinned
`get-contact` read action. A caller cannot provide a package or action name.
The adapter supplies only bounded props and an in-memory OAuth access token,
then validates and normalizes the provider response.

Tests intercept `https://api.hubapi.com`; no real HubSpot request or customer
credential is used. Activepieces server, PostgreSQL, Redis, projects, flows,
connections, webhooks, and API keys are not involved.

## Trust conclusion

The selected action is invokable with a small adapter, but the bundled package
contains code capable of filesystem and unrestricted network access. JavaScript
credential strings also cannot be reliably zeroed in a long-lived process.
Generic pieces must therefore execute in a fresh restricted process at minimum,
with container or equivalent sandbox isolation preferred for community code.
The current Connector Runner process must not import arbitrary piece packages.

Before using a piece in production, CrazyLoops needs an allowlisted package,
version, integrity hash, license, capability/action, provider domains, static
forbidden-import review, vulnerability review, output schema, timeout policy,
and human-reviewed update process.
