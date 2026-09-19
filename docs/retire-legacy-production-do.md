# Production-only legacy Durable Object retirement

> Historical reference: the results, settings and actions below apply to the stated version or review period. For current use, follow the [documentation index](README.md), [upgrade guide](upgrading.md) and [release status](release-readiness.md).

The owner authorized permanent deletion of the RegistryDO and RunnerDO namespaces owned by production Worker runmesh. No backup is claimed. V2 namespaces, D1, credentials, local Runner state and other Workers are not deletion targets.

Production now uses declarative exports: RegistryDOv2 and RunnerDOv2 retain their existing SQLite classes/bindings, while only RegistryDO and RunnerDO become deleted tombstones. The production entrypoint exports the same v2 class objects and unchanged handlers. Internal base implementations remain because v2 depends on them. Development/test explicitly retain their old entrypoint and migration history, so their similarly named namespaces are not removed.

Cloudflare reconciles this declaration against actual existing resources. If another Worker references an old namespace, the provider rejects the deletion with tombstone_delete_blocked_by_external_bindings; do not bypass that refusal or remove another project's bindings. Local maintenance access does not include account-wide Cloudflare inventory. Successful CI or webhook acknowledgement alone is not deletion evidence.

The live v2 namespaces remain in place when switching from migrations to exports. Once switched, future production deploys cannot return to migrations. Preserve these lifecycle declarations when rolling source back. Deletion cannot recover old data; do not recreate, rename or transfer namespaces as a workaround. Remove a stale deletion tombstone only after Cloudflare reconciliation reports it safe.

Reference: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/

Validation covers exact retirement names, environment scope, v2 implementation identity/state and production/development/test builds. No runtime SQL, new timer, credential change, Runner artifact replacement or service restart is introduced. Deploy only through protected main and the existing GitLab connection, then check Cloudflare result and live service continuity.
