# Admin presentation boundaries (AR04)

This development change extracts presentation from the existing Worker entrypoint. It does not introduce a new frontend framework, route, storage layer or polling loop.

`src/admin/` owns the existing page renderers, formatting, forms, tables, branding and browser script. Renderers take data and CSRF values supplied by their caller and return markup synchronously. They do not fetch Registry records or receive Worker environment bindings. The client detail renderer no longer accepts the formerly unused environment argument or returns a needless Promise.

`src/http/html-response.ts` owns the existing response headers, redirects, cookie attachment and nonce insertion for the application-owned script. It does not grant authorization. The current entrypoint remains responsible for authentication, CSRF, request-body limits, trusted execution-mode selection, enrollment validation and data retrieval before rendering. Enrollment views receive an already validated public origin and mode; their presence is not permission to issue a code.

This is the presentation/HTTP-envelope slice of AR04. Business route dispatch and mutation orchestration deliberately remain in the entrypoint pending separately reviewed extraction. Registry persistence and final RPC authorization are unchanged.

## Compatibility evidence

`test/fixtures/admin-render-golden.json` records thirteen render results generated from `88b119782d26316d68eeaa98a47d71dbe4382193`, including its source-file SHA-256. Both old and extracted views use the same fixed clock. `admin-view-contracts.test.ts` compares exact UTF-8 byte counts and hashes, verifies escaping and exercises the HTML security headers. Existing authenticated Worker UI, enrollment, CSRF and locale tests remain in place.

`test/admin-navigation.test.mjs` reads the relocated browser implementation; it still checks explicit no-store navigation, no background Jobs/log requests, stale DOM removal and stable language selection. A source relocation must not narrow the set of labels checked by the language regression.

No response changes, additional Registry calls, timers or production deployment are implied by moving these functions. These are source/test facts, not a browser performance or Cloudflare billing measurement.
