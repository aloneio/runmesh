import { centralProductView } from "./central-product-view.js";

/** All content is local presentation. Responses are rendered with textContent. */
export function centralPage(csrf: string, enabled: boolean, skills: boolean): string {
  if (!enabled) return '<section class="page-heading"><h1>Central capabilities</h1><p>Central capabilities are disabled.</p></section>';
  return centralProductView(csrf, skills);
}
