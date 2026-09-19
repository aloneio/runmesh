# Admin presentation boundaries

Use this reference when maintaining administrator pages. Page rendering, HTTP security and application operations have separate responsibilities; keep those boundaries when adding a page or action.

`src/admin/` owns page renderers, formatting, forms, tables, branding and the script envelope. Browser implementation is authored in `apps/worker/browser/admin-client.js`; its generated module is not hand-edited. `contracts/admin-views.ts` owns the display DTOs, independent of Registry records. Renderers take data and CSRF values supplied by their caller and return markup synchronously. They do not fetch Registry records or receive Worker environment bindings. The client detail renderer no longer accepts the formerly unused environment argument or returns a needless Promise.

`src/http/html-response.ts` owns the existing response headers, redirects, cookie attachment and nonce insertion for the application-owned script. It does not grant authorization. HTTP adapters remain responsible for authentication, CSRF, request-body limits and response representation; application modules own lifecycle/policy coordination and field projections before rendering. Enrollment views receive an already validated public origin and mode; their presence is not permission to issue a code.

HTTP adapters and application use cases are separate from the entrypoint. Browser and API callers share the Runner deletion use case; renderers must not implement their own deletion or authorization sequence.

## Compatibility evidence

`test/fixtures/admin-render-golden.json` records thirteen render results generated from `88b119782d26316d68eeaa98a47d71dbe4382193`, including its source-file SHA-256. Both old and extracted views use the same fixed clock. `admin-view-contracts.test.ts` compares exact UTF-8 byte counts and hashes, verifies escaping and exercises the HTML security headers. Existing authenticated Worker UI, enrollment, CSRF and locale tests remain in place.

`test/admin-navigation.test.mjs` reads the relocated browser implementation; it still checks explicit no-store navigation, no background Jobs/log requests, stale DOM removal and stable language selection. A source relocation must not narrow the set of labels checked by the language regression.

Run the relevant Worker UI and browser tests when changing these modules. Rendering fixtures check output compatibility; use separate measurements for browser performance or Cloudflare usage.
