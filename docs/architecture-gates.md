# Source dependency gates (AR01)

`npm run check:architecture` parses application/protocol source using the pinned development-only Babel parser. It does not import the scanned modules or execute their embedded installer text. Both GitHub and GitLab verification run this command, and CI parity checks require its presence. The checker fixtures also run in the existing native platform jobs.

## Enforced boundaries

Worker and Runner may depend on the shared protocol, not one another. The protocol may not depend on either application. Node built-ins belong to Runner; Cloudflare/Worker platform packages belong to Worker. These rules include type dependencies: type-only imports avoid runtime cycles but do not make reverse architectural dependencies desirable.

The graph includes import declarations, re-exports, literal dynamic imports, literal CommonJS `require`, TypeScript import types and external-module references. Unresolved relative modules, unknown project package subpaths, aliases without mappings and computed module loads fail closed. Source symlinks are not silently skipped. Type-only strongly connected components are reported separately; existing type cycles are not mislabeled as runtime initialization cycles.

The policy lives in `scripts/architecture-policy.mjs`; graph discovery and cycle detection live in `scripts/architecture-graph.mjs`. Runtime cycles fail the gate. Existing retired-name/configuration checks remain. The ignored generated Worker provenance module is the only explicitly permitted missing generated input before builds run; TypeScript and the build still must generate and validate it.

## Limits and non-goals

This is a source dependency gate, not a security sandbox or a certification of all code semantics. It does not analyze dependency internals, embedded script strings, reflection/eval or runtime network loading. It conservatively treats bare `require()` as module loading. No application source is rewritten by the check. Parsing is bounded to 5,000 files, 1 MiB per file, 16 MiB total source and 20,000 directory entries. Tooling failures fail the check rather than reporting a clean graph.

One existing type-inclusive protocol component is advisory until its type ownership is separately refactored. This gate does not introduce an arbitrary maximum line count or claim that a smaller file is automatically more maintainable. Later architectural boundaries must be added with both allowed and forbidden fixtures.

The parser is now an explicit exact-version development dependency already present in the lockfile, not a new runtime component. No Worker/Runner settings, storage, privileges, timers, requests or public tool schemas change in AR01.

Reference for parser options and supported syntax: https://babeljs.io/docs/babel-parser
