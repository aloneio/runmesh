# Foundation and contract ownership (AR03)

This is a source-organization change, separate from AR02's error semantics. It does not change scopes, SQL, storage formats, origin acceptance, response fields, public tool schemas, timers, deployment configuration or release constants.

`public-origin.ts` owns canonical HTTPS origin and request/Host validation. The functions were moved unchanged; `installer.ts` retains compatibility re-exports and imports only the function needed by its own templates. `runtime-config.ts` imports this small foundation directly, so Registry/Runner configuration no longer depends on installation script rendering.

`platform/env.ts` owns Worker bindings and configuration types. RunnerDO and the Worker entry import it; the old RunnerDO type export remains available for compatibility. Platform types describe bindings but instantiate nothing. They are not a generic mutable service locator or an authorization cache.

`contracts/runner-selection.ts` owns the narrow connection-state, policy-readiness and MCP Runner-selection response types shared across internal boundaries. Registry implements and re-exports these types for existing consumers. MCP imports the contract and platform definitions rather than obtaining ordinary types from concrete Registry/RunnerDO classes.

AR01's dependency gate now rejects a return to the old ownership: runtime configuration cannot import installer templates; application contracts cannot import implementation/platform adapters; MCP cannot import concrete Registry, RunnerDO or the Worker entry, even for types. Compatible type-only imports are exercised separately.

The complete latest Registry schema and large domain implementations are not moved here. In particular, no asynchronous operation is inserted into the final RunnerDO authorization-to-send section, and no SQL transaction is wrapped in a new Promise. Broader Registry, HTTP/UI and Job/Context decomposition remains AR04–AR07.

Validation compares the pre/post tool catalog fingerprint and all six generated install/uninstall scripts for a fixed synthetic domain. Origin rejection, routed custom domains, reverse-proxy overrides, installer compatibility exports and type compatibility have regressions. Existing permission, outages, inline rendering and end-to-end tests remain required; reduced import count alone is not a performance or security claim.
