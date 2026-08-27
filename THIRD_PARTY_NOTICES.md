# Third-party notices

## Scope

This file records third-party dependency and asset boundaries for the source
repository. The repository's PolyForm Noncommercial License 1.0.0 applies only
to Runmesh material for which the applicable rights holder grants those terms.
It does not relicense third-party software, dependencies, external
contributions, or trademarks.

No third-party source or asset is identified as copied into this source tree by
the current design-research audit. If copied or vendored material is added,
record its exact source, license, required notices, and redistribution impact
before merging or distributing it.

## Runtime dependency notices

At the current lockfile revision, direct runtime dependencies include:

| Workspace | Dependency | Locked version | Declared license |
| --- | --- | ---: | --- |
| root / Runner | [`ws`](https://www.npmjs.com/package/ws) | 8.21.3 | MIT |
| Worker | [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) | 2.0.0 | MIT |
| Worker | [`agents`](https://www.npmjs.com/package/agents) | 0.21.0 | MIT |
| Worker / Protocol | [`zod`](https://www.npmjs.com/package/zod) | 4.4.3 | MIT |

The lockfile also records licenses for transitive and development dependencies.
It is the reproducible dependency inventory for this revision, not a
substitute for license files shipped by upstream packages. Release builders
must review the exact dependency set and include every upstream notice required
by the resulting artifact. The dependency inventory includes MIT, Apache-2.0,
ISC, BSD, MPL-2.0, LGPL-3.0-or-later, CC0-1.0, CC-BY-4.0, and other
expressions; not every expression appears in every artifact.

The public Runner and protocol packages carry their current `LICENSE`,
`NOTICE`, and `THIRD_PARTY_NOTICES.md`. npm installs dependencies separately;
upstream license files and notices must be retained when dependencies are
redistributed. The private Worker workspace is not a published npm artifact.

## Distribution reminder

Do not delete, replace, or obscure upstream license files or notices. If you
create a bundled, container, binary, or vendored distribution, generate and
review a release-specific third-party notice set from the exact shipped inputs.
This document is an inventory aid, not legal advice or a complete bill of
materials for every possible build.
