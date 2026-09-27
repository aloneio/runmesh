import { escapeHtml } from "./format.js";

export function centralProductView(csrf: string, skills: boolean): string {
  return '<section class="page-heading"><div><h1>MCP &amp; Skill</h1></div><a class="button secondary" href="/admin/clients#add-client">Connect an AI client</a></section>'
    + '<div data-central-product data-csrf="' + escapeHtml(csrf) + '" data-skills="' + String(skills) + '">'
    + '<p data-product-status role="status" aria-live="polite" data-no-i18n></p>'
    + '<nav class="central-tabs" aria-label="Capability library"><button type="button" class="button" data-central-tab="services" aria-pressed="true">MCP</button>'
    + (skills ? '<button type="button" class="button secondary" data-central-tab="skills" aria-pressed="false">Skill</button>' : '')
    + '<button type="button" class="button secondary" data-product-refresh>Refresh</button></nav>'
    + '<section data-central-panel="services"><div class="central-grid"><section class="panel"><h2>Connected MCPs</h2><div data-service-list></div></section><section class="panel"><h2>Connect MCP</h2><form data-service-create><label>MCP URL<input name="endpoint" type="url" required maxlength="2048" placeholder="https://mcp.example.com/mcp" autocomplete="url"></label><label>Authentication<select name="authentication"><option value="none">No authentication</option><option value="oauth">OAuth</option></select></label><label>MCP name (optional)<input name="name" maxlength="64" placeholder="e.g. Team documentation"></label><button type="submit" class="button">Connect</button></form></section></div><section class="panel" data-service-tools hidden></section></section>'
    + (skills ? '<section data-central-panel="skills" hidden><div class="central-grid"><section class="panel"><h2>Your Skills</h2><div data-skill-list></div></section><section class="panel"><h2>Install a Skill</h2><p>Select SKILL.md and its supporting text files, or select the whole Skill folder.</p><form data-skill-import><label>Skill files<input type="file" name="files" multiple></label><label>Skill folder<input type="file" name="folder" webkitdirectory multiple></label><button class="button" type="submit">Install Skill</button></form></section></div><section class="panel" data-skill-review hidden></section></section>' : '')
    + '<noscript>Enable JavaScript to use the guided capability library.</noscript></div>';
}
