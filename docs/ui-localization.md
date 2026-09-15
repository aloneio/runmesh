# UI localization contract

The administrator interface supports English and Simplified Chinese. Explicit
`lang` query selection wins over the `runmesh_lang` cookie and the weighted
`Accept-Language` header. Region/script variants use the supported base language;
this does not add a separate Traditional Chinese catalog. A valid explicit
selection is saved in the HTML response, without replacing session cookies.

## Authored messages and data

Templates use canonical English. The server translates complete authored text
nodes and selected accessible attributes before the first paint. Split dynamic
sentences at intentional markup boundaries; do not concatenate translated labels,
untranslated sentences and user data into one translation key. The browser must
not repeatedly translate rendered DOM text or poll for translated content.

`ui-catalog.ts` has one immutable mapping. Duplicate keys and later overlays are
rejected by the catalog regression test. Context-specific meanings use distinct
source labels: workspace `Disabled` is not cloud-history `Do not upload`.
Translations must preserve restricted-account defaults, explicit privilege
confirmation, uncertainty and the complete scope of destructive cleanup.

User names, IDs, commands, credentials and logs are not interface messages.
Mark data with `data-no-i18n` or `translate="no"`; attributes of opted-out elements
are also preserved. Script/style/code/pre/textarea/SVG content is not translated.
Machine error codes remain unchanged even when the adjacent status is translated.
Never translate form values, request parameters, command flags or permission bits.

## Regression evidence

`test/ui-catalog.test.mjs` checks unique immutable keys, authored language and
literal administrator errors. `apps/worker/test/ui-locale.test.ts` exercises real
Worker HTML rewriting, enrollment modes, streaming/entity boundaries, language
selection, data preservation and critical translation meaning.

Four HTML fixtures intentionally change for data-exclusion/accessibility markers;
their original hashes remain recorded. This is not a claim that their markup is
unchanged. The eight enrollment command variants were compared with the original
source and retain identical preformatted command bytes.

Run the existing UI/browser integration checks on a local test instance. Source
tests and a development merge do not deploy production, update installed Runners
or prove that all possible user-supplied content has a translation.
