# Foundation and contract ownership

Use this reference when changing shared Worker configuration or application contracts. Deployment settings are described in [runtime configuration](runtime-config.md).

| Module | Owns | Consumers |
| --- | --- | --- |
| `public-origin.ts` | Canonical HTTPS origin and request/Host validation | Runtime configuration and installer templates; installer compatibility exports remain available |
| `platform/env.ts` | Worker binding and configuration types | RunnerDO and Worker entry; the older RunnerDO type export remains available |
| `contracts/runner-selection.ts` | Connection state, policy readiness and MCP Runner-selection response types | Registry implementations and MCP callers |

Import shared types from their contract module and configuration rules from their foundation. Keep platform binding types declarative; instantiate services at the composition boundary. Registry continues to re-export compatibility types for existing callers.

The [dependency gate](architecture-gates.md) checks these directions. Runtime configuration imports origin rules directly. Application contracts stay independent of implementation adapters. MCP uses contracts and platform definitions rather than concrete Registry, RunnerDO or entrypoint classes.

Preserve the synchronous final RunnerDO authorization-to-send section and the synchronous Registry transaction owner. See [architecture](architecture.md) for the surrounding HTTP, application, presentation, Job and Context responsibilities.

After changing a foundation, run architecture checks and the affected origin, installer, contract and permission regressions. Add end-to-end checks when dispatch or enrollment behavior changes, and measure performance separately when it is a goal of the change.
