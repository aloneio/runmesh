# Admin presentation boundaries

Use this reference when maintaining administrator pages. Page rendering, HTTP security and application operations have separate responsibilities; keep those boundaries when adding a page or action.

`src/admin/` owns page renderers, formatting, forms, tables, branding and the script envelope. `contracts/admin-views.ts` owns display DTOs. Renderers receive explicit data and CSRF values and return markup synchronously; callers load records and select display fields before rendering.

`apps/worker/browser/` owns browser behavior. Its `admin-client.js` entry composes the page, navigation and workflow modules; edit behavior in the module that owns it and regenerate the Worker bundle through the build.

`src/http/html-response.ts` owns response headers, redirects, cookie attachment and nonce insertion for the application-owned script. HTTP adapters authenticate requests, check CSRF and body limits, and select the response representation. Application modules coordinate lifecycle and policy operations and project display fields. Validate the public origin and execution mode before rendering enrollment, and authorize code issuance at its request boundary.

The entrypoint assembles HTTP adapters and application use cases. Browser and API callers share the Runner deletion use case, keeping its authorization and mutation sequence in one place.

## Compatibility evidence

`apps/worker/test/fixtures/admin-render-golden.json` records thirteen render results generated from `88b119782d26316d68eeaa98a47d71dbe4382193`, including its source-file SHA-256. Both old and extracted views use the same fixed clock. `admin-view-contracts.test.ts` compares exact UTF-8 byte counts and hashes, verifies escaping and exercises the HTML security headers. Existing authenticated Worker UI, enrollment, CSRF and locale tests remain in place.

`test/admin-navigation.test.mjs` checks explicit no-store navigation, stale DOM removal, page ownership, control binding and stable language selection. `test/central-browser.test.mjs` covers MCP and Skill workflows, operation admission and response receipts.

In `apps/worker/test/`, `jobs-dashboard.test.ts` and `admin-jobs.test.ts` check user-initiated history and log loading; `ui-locale.test.ts` checks the rendered language and label coverage. Preserve that coverage when moving source.

Run the relevant Worker UI and browser tests when changing these modules. Rendering fixtures check output compatibility; use separate measurements for browser performance or Cloudflare usage.
