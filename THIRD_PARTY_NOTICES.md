# Third-party notices

## Scope

This file records the third-party-license boundary for the source repository.
The repository's current PolyForm Noncommercial License 1.0.0 applies only to
material for which an applicable rights holder has granted those terms. It does
not relicense third-party software, dependencies, prior Apache-licensed
copies, or marks.

No third-party source or asset is identified as copied into this source tree by
the reachable Git history and documentation audit performed for the license
migration. The project documents independent design research only; it does not
claim that those research references supplied source code. If copied material
is added later, its exact license and required notices must be added before
merging or distributing it.

## Runtime dependency notices

At lockfile version 0.1.0, the direct runtime dependencies are installed by npm
as separate packages. Their upstream license files remain with those packages
and must be retained when a distribution bundles or redistributes them:

| Workspace | Dependency | Locked version | Declared license |
| --- | --- | ---: | --- |
| root / Runner | [`ws`](https://www.npmjs.com/package/ws) | 8.21.3 | MIT |
| Worker | [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) | 2.0.0 | MIT |
| Worker | [`agents`](https://www.npmjs.com/package/agents) | 0.21.0 | MIT |
| Worker / Protocol | [`zod`](https://www.npmjs.com/package/zod) | 4.4.3 | MIT |

The lockfile also records licenses for transitive and development dependencies.
It is the reproducible dependency inventory for this revision; it is not a
substitute for the license files shipped by upstream packages. Release builders
must review the actual dependency set and include every upstream notice required
by the resulting artifact. In particular, dependency entries include MIT,
Apache-2.0, ISC, BSD, MPL-2.0, LGPL-3.0-or-later, CC0-1.0, CC-BY-4.0, and other
expressions; not all are included in every platform artifact.

The public Runner and protocol npm packages carry package-specific
`THIRD_PARTY_NOTICES.md`, their current `LICENSE`, and the historical Apache
record in their packed file lists. The private Worker workspace is not a
published npm artifact.

## Historical and research references

The previous Apache 2.0 project license is preserved verbatim at
[`LICENSES/Apache-2.0-history.txt`](LICENSES/Apache-2.0-history.txt); see
[LICENSE_HISTORY.md](LICENSE_HISTORY.md) for its provenance and scope.

The README acknowledges design research concerning `xyTom/coding-tools-mcp`,
`volter-ai/volter-tunnel`, `Hiroshimeow/agent-mcp-gateway`, and documentation
from Cloudflare and the MCP ecosystem. They are not represented as bundled or
copied source. Their names and marks remain their owners' property.

## Distribution reminder

Do not delete, replace, or obscure upstream license files or notices. If you
create a bundled, container, binary, or vendored distribution, generate and
review a release-specific third-party notice set from the exact shipped inputs.
This document is an inventory aid, not legal advice or a complete bill of
materials for every possible build.
