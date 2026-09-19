# UI localization contract

The administrator interface supports English and Simplified Chinese. Explicit
`lang` query selection wins over the `runmesh_lang` cookie and the weighted
`Accept-Language` header. Region/script variants use one of these two supported
catalogs. A valid explicit selection is saved in the HTML response alongside the
existing session cookies.

## Authored messages and data

Templates use authored messages and canonical English compatibility strings. New messages use the typed keys in `i18n/messages.ts`. The server translates complete authored text
nodes and selected accessible attributes before the first paint. Split dynamic
sentences at intentional markup boundaries and keep user data separate from
translation keys. Render the selected language on the server so the browser
receives ready-to-display text.

`ui-catalog.ts` has one immutable mapping. Duplicate keys and later overlays are
rejected by the catalog regression test. Context-specific meanings use distinct
source labels, such as workspace `Disabled` and cloud-history `Do not upload`.
Translations must preserve restricted-account defaults, explicit privilege
confirmation, uncertainty and the complete scope of destructive cleanup.

Keep user names, IDs, commands, credentials and logs verbatim. Mark data with
`data-no-i18n` or `translate="no"`; the element's attributes are preserved too.
Script/style/code/pre/textarea/SVG content, machine error codes, form values,
request parameters, command flags and permission bits retain their original bytes.
Translate the surrounding labels and status text.

## Regression evidence

`test/ui-catalog.test.mjs` checks unique immutable keys, authored language and
literal administrator errors. `apps/worker/test/ui-locale.test.ts` exercises real
Worker HTML rewriting, enrollment modes, streaming/entity boundaries, language
selection, data preservation and critical translation meaning.

When updating fixtures, review data-exclusion and accessibility markers as well as visible text. Keep copied enrollment commands unchanged unless their command contract is intentionally updated.

Run the UI/browser integration checks on a local test instance. Review both
languages for meaning, layout and accessible labels, then verify the deployed
pages through the normal Worker deployment procedure.
