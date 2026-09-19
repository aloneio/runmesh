# Foundation and contract ownership

Use this reference when changing shared Worker configuration or application contracts. For deployment settings, use [runtime configuration](runtime-config.md).

`public-origin.ts` owns canonical HTTPS origin and request/Host validation. `installer.ts` retains compatibility re-exports and imports the function needed by its templates. `runtime-config.ts` imports this foundation directly, keeping Registry/Runner configuration independent of installer rendering.

`platform/env.ts` owns Worker bindings and configuration types. RunnerDO and the Worker entry import it; the old RunnerDO type export remains available for compatibility. Platform types describe bindings but instantiate nothing. They are not a generic mutable service locator or an authorization cache.

`contracts/runner-selection.ts` owns the narrow connection-state, policy-readiness and MCP Runner-selection response types shared across internal boundaries. Registry implements and re-exports these types for existing consumers. MCP imports the contract and platform definitions rather than obtaining ordinary types from concrete Registry/RunnerDO classes.

The [dependency gate](architecture-gates.md) enforces these boundaries: runtime configuration cannot import installer templates; application contracts cannot import implementation/platform adapters; MCP cannot import concrete Registry, RunnerDO or the Worker entry, even for types.

Keep the final RunnerDO authorization-to-send section synchronous, and preserve the synchronous Registry transaction owner. Registry schema and domain modules, HTTP/application/presentation layers, and Job/Context adapters have separate responsibilities described in [architecture](architecture.md).

When changing these foundations, run the architecture checks and relevant origin, installer, contract and permission regressions. Include end-to-end checks if dispatch or enrollment behavior changes; fewer imports alone do not demonstrate better performance or security.
