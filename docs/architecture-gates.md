# Source dependency checks

Run `npm run check:architecture` when adding or moving modules. The command parses application and protocol source with the pinned development-only Babel parser. GitHub and GitLab verification both run it; the native platform jobs also exercise its fixtures.

## Dependency rules

Worker and Runner depend on the shared protocol. Keep application-specific dependencies out of that protocol, Node built-ins in Runner adapters, and Cloudflare platform packages in Worker adapters. Type imports follow the same direction as runtime imports.

The graph covers import declarations, re-exports, literal dynamic imports, literal CommonJS `require`, TypeScript import types and external-module references. Resolve relative imports and project aliases explicitly. Computed module loads, unresolved modules, unsupported package subpaths and source symlinks fail the check. Runtime and type-inclusive cycles are classified separately, and both fail.

`scripts/architecture-policy.mjs` defines roles and allowed edges. `scripts/architecture-graph.mjs` discovers imports and detects cycles. The generated Worker provenance and browser modules are permitted to be absent before a build; build and typecheck prepare and validate them.

## Maintain the gate

Add both allowed and forbidden fixtures for a new boundary. Keep examples for type imports, supported file extensions, re-exports and intermediary modules so a rename preserves the same dependency rules.

External SDK imports are checked against Worker roles. HTTP/MCP adapters can load their reviewed server SDKs; domain, contract, presentation and browser modules use their own narrower dependencies. Node classification uses the runtime `isBuiltin` predicate. New Job, Context, Patch and Connection files default to the pure role; register platform adapters explicitly.

Connection submodules depend on narrow ports, while the connection coordinator owns runtime, policy and Job integration. Release models and selection stay separate from release I/O and installer rendering. Patch data contracts use `path-contracts.ts`. See [the ownership reference](architecture-remediation.md#ar09ar14-platform-boundaries-and-failure-seams) for the corresponding roles.

Fixtures cover `.mts`, `.cts`, JSX, bare built-ins such as `dgram` and `dns/promises`, type-only Cloudflare imports, renamed barrels, nested modules and reverse coordinator dependencies. Positive fixtures cover native adapters, pure hashing and type-only platform ports. Four named Runtime persistence-coordinator test exceptions retain timing that a file-write fault cannot reproduce; replacing one requires equivalent fault timing and assertions.

Central MCP providers consume public contracts, helpers within their own provider and reviewed server/schema SDKs. They cannot import application or platform implementations, unreviewed external packages, client SDKs, or platform I/O globals. Fixtures include direct imports, types, re-exports, nested helpers and dynamic imports. Protocol execution and persistence are injected through ports by composition.

## Scope and limits

The checker reads source without importing it or executing embedded installer text. It conservatively treats bare `require()` as module loading. Parsing is bounded to 5,000 files, 1 MiB per file, 16 MiB total source and 20,000 directory entries; parser or tooling failures produce a failed check.

Use runtime and security tests for dependency internals, embedded scripts, reflection/eval and runtime network loading. Evaluate a refactor by its ownership, dependency direction and preserved behavior; line count is only a navigation aid.

Parser reference: [Babel parser options and syntax](https://babeljs.io/docs/babel-parser).
