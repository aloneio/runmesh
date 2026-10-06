import { escapeHtml } from "./format.js";
import { SKILL_LIMITS } from "../contracts/skills.js";

export function centralProductView(csrf: string, skills: boolean): string {
  return `<section class="page-heading">
    <div><p class="eyebrow">YOUR AI WORKSPACE</p><h1>MCP &amp; Skill</h1><p class="lede">Connect an MCP or install a Skill.</p></div>
    <a class="button secondary" href="/admin/clients#add-client">Connect an AI client</a>
  </section>
  <div data-central-product data-csrf="${escapeHtml(csrf)}" data-skills="${String(skills)}">
    <div class="central-toolbar">
      <nav class="central-tabs" aria-label="MCP and Skill tabs">
        <button type="button" class="button" data-central-tab="services" aria-pressed="true" aria-controls="central-mcp-panel">MCP</button>
        ${skills ? '<button type="button" class="button secondary" data-central-tab="skills" aria-pressed="false" aria-controls="central-skill-panel">Skill</button>' : ''}
      </nav>
      <button type="button" class="button secondary" data-product-refresh>Refresh</button>
    </div>
    <p data-product-status role="status" aria-live="polite" data-no-i18n></p>
    <section data-central-panel="services" id="central-mcp-panel">
      <div class="central-grid">
        <section class="panel central-library-panel" aria-labelledby="connected-mcp-title">
          <div class="section-title"><h2 id="connected-mcp-title">Connected MCPs</h2></div>
          <div class="central-list" data-service-list></div>
        </section>
        <section class="panel central-connect-panel" aria-labelledby="connect-mcp-title">
          <div class="section-title"><h2 id="connect-mcp-title">Connect MCP</h2></div>
          <form class="connection-form" data-service-create>
            <label>MCP URL<input name="endpoint" type="url" required maxlength="2048" placeholder="https://mcp.example.com/mcp" autocomplete="url"></label>
            <label>Authentication<select name="authentication"><option value="none">No authentication</option><option value="oauth">OAuth</option></select></label>
            <label>MCP name (optional)<input name="name" maxlength="64" placeholder="e.g. Team documentation"></label>
            <div class="form-submit-wrap"><button type="submit" class="button">Connect</button></div>
          </form>
        </section>
      </div>
      <section class="panel central-detail-panel" data-service-tools hidden></section>
    </section>
    ${skills ? `<section data-central-panel="skills" id="central-skill-panel" hidden>
      <div class="central-grid">
        <section class="panel central-library-panel" aria-labelledby="installed-skills-title">
          <div class="section-title"><h2 id="installed-skills-title">Installed Skills</h2></div>
          <div class="central-list" data-skill-list></div>
        </section>
        <section class="panel central-connect-panel" aria-labelledby="install-skill-title">
          <div class="section-title"><h2 id="install-skill-title">Install a Skill</h2></div>
          <p class="muted">Select SKILL.md and its supporting text files, or select the whole Skill folder.</p>
          <form class="connection-form" data-skill-import data-max-files="${SKILL_LIMITS.files}" data-max-file-bytes="${SKILL_LIMITS.file_bytes}" data-max-bundle-bytes="${SKILL_LIMITS.bundle_bytes}">
            <label class="skill-file-choice">Skill files<input type="file" name="files" multiple></label>
            <label class="skill-file-choice">Skill folder<input type="file" name="folder" webkitdirectory multiple></label>
            <div class="form-submit-wrap"><button class="button" type="submit">Install Skill</button></div>
          </form>
        </section>
      </div>
      <section class="panel central-detail-panel" data-skill-review hidden></section>
    </section>` : ''}
    <noscript>Enable JavaScript to manage MCPs and Skills.</noscript>
  </div>`;
}
