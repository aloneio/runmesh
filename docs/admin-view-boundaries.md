# Admin presentation boundaries

Use this reference when maintaining administrator pages. Page rendering, HTTP security and application operations have separate responsibilities; keep those boundaries when adding a page or action.

`src/admin/` owns page renderers, formatting, forms, tables, branding and the script envelope. Edit browser behavior in `apps/worker/browser/admin-client.js` and regenerate its Worker module through the build. `contracts/admin-views.ts` owns display DTOs. Renderers receive explicit data and CSRF values and return markup synchronously; callers load records and select display fields before rendering.

`src/http/html-response.ts` owns response headers, redirects, cookie attachment and nonce insertion for the application-owned script. HTTP adapters authenticate requests, check CSRF and body limits, and select the response representation. Application modules coordinate lifecycle and policy operations and project display fields. Validate the public origin and execution mode before rendering enrollment, and authorize code issuance at its request boundary.

The entrypoint assembles HTTP adapters and application use cases. Browser and API callers share the Runner deletion use case, keeping its authorization and mutation sequence in one place.

## Compatibility evidence

`test/fixtures/admin-render-golden.json` records thirteen render results generated from `88b119782d26316d68eeaa98a47d71dbe4382193`, including its source-file SHA-256. Both old and extracted views use the same fixed clock. `admin-view-contracts.test.ts` compares exact UTF-8 byte counts and hashes, verifies escaping and exercises the HTML security headers. Existing authenticated Worker UI, enrollment, CSRF and locale tests remain in place.

`test/admin-navigation.test.mjs` checks explicit no-store navigation, user-initiated Job/log loading, stale DOM removal and stable language selection. Preserve the language regression's label coverage when moving source.

Run the relevant Worker UI and browser tests when changing these modules. Rendering fixtures check output compatibility; use separate measurements for browser performance or Cloudflare usage.
