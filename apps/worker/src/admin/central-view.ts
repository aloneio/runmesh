import { escapeHtml } from "./format.js";

/** All content is local presentation. Responses are rendered with textContent. */
export function centralPage(csrf: string, enabled: boolean, skills: boolean, governance: boolean): string {
  if (!enabled) return '<section class="page-heading"><h1>Central capabilities</h1><p>Central capabilities are disabled.</p></section>';
  const operation = (value: string, label: string) => '<option value="' + value + '">' + label + '</option>';
  return '<section class="page-heading"><h1>Central capabilities</h1><p class="lede">Configure once, explicitly approve, then grant each client. No Runner is required.</p></section>'
    + '<section class="panel"><h2>Review and manage</h2><p>Read first to obtain the current revision. Mutations require that exact revision; failures never replay automatically.</p>'
    + '<form data-central-admin data-csrf="' + escapeHtml(csrf) + '"><label>Operation<select name="operation">'
    + operation('profiles', 'List connection profiles')
    + operation('profile-read', 'Read connection profile')
    + operation('profile-write', 'Create, rotate, enable or disable profile')
    + operation('catalog-read', 'Review catalog and changes')
    + operation('catalog-discover', 'Discover into pending catalog')
    + operation('catalog-write', 'Approve or disable catalog')
    + operation('oauth-begin', 'Begin upstream authorization') + operation('oauth-inspect', 'Inspect upstream authorization') + operation('oauth-revoke', 'Revoke upstream authorization')
    + operation('grant-read', 'Read client grants')
    + operation('grant-write', 'Replace client grants')
    + operation('toolset-read', 'Read reusable toolset') + operation('toolset-write', 'Save or apply reusable toolset')
    + (skills ? operation('skill-read', 'Review Skill bundle') + operation('skill-write', 'Preview, stage, activate or disable Skill') : '')
    + (governance ? operation('receipts', 'Recent call receipts') : '')
    + '</select></label><label>Profile, client or Skill ID<input name="target" maxlength="128" autocomplete="off"></label>'
    + '<label>Request JSON<textarea name="payload" rows="12" spellcheck="false">{}</textarea></label>'
    + '<p>Never paste inbound Runmesh or Runner secrets here. Bearer credentials are write-only.</p>'
    + '<button class="button" type="submit">Execute selected operation</button></form>'
    + '<pre data-central-result role="status" aria-live="polite">Select a read operation to begin.</pre></section>'
    + '<section class="panel"><h2>Request examples</h2><p>IDs come from the field above. Each update uses the revision returned by its last read.</p>'
    + '<h3>Profile</h3><pre>' + escapeHtml(JSON.stringify({ action: 'create', connector_id: 'documentation', endpoint: 'https://docs.example.com/mcp', credential: { kind: 'bearer', token: 'REPLACE_WITH_UPSTREAM_TOKEN' } }, null, 2)) + '</pre>'
    + '<h3>Discovery</h3><pre>{&quot;expected_revision&quot;:0}</pre><h3>Approval</h3><pre>{&quot;action&quot;:&quot;approve&quot;,&quot;expected_revision&quot;:1,&quot;digest&quot;:&quot;REVIEWED_DIGEST&quot;,&quot;tool_names&quot;:[&quot;search&quot;]}</pre>'
    + '<h3>Client grant</h3><pre>{&quot;expected_revision&quot;:0,&quot;enabled&quot;:true,&quot;rules&quot;:[{&quot;kind&quot;:&quot;skill&quot;,&quot;resource_id&quot;:&quot;research&quot;,&quot;version&quot;:&quot;APPROVED_DIGEST&quot;}]}</pre>'
    + '<h3>Skill</h3><p>Import a text file collection with action preview, then stage. Review the returned digest before activate. Bundle fields: source, license, files: [{path, text}]. Include SKILL.md with scalar name and description frontmatter. Scripts remain text.</p>'
    + '<pre>{&quot;action&quot;:&quot;activate&quot;,&quot;expected_revision&quot;:1,&quot;digest&quot;:&quot;REVIEWED_DIGEST&quot;}</pre></section>';
}
