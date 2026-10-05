import { bindCentralProduct } from "./central/controller.js";
import { bindRunnerActions } from "./runner-actions.js";
import { createLocale } from "./locale.js";
import { createPageControls } from "./page-controls.js";
import { createAdminPages } from "./admin-pages.js";
import { createAdminNavigation } from "./admin-navigation.js";

const locale = createLocale({ document });
let navigation;
const navigate = url => navigation.navigate(url);
const controls = createPageControls({ document, window, navigator, location, locale, navigate });
function bindPage(root) {
  const isCurrent = navigation.capturePage();
  controls.bindPageControls(root);
  bindCentralProduct(root, { isCurrent, navigate });
  bindRunnerActions(root, { isCurrent, navigate });
  navigation.bind(root);
}
const view = createAdminPages({ document, location, history, bindPage, locale });
navigation = createAdminNavigation({ document, location, view, locale,
  fetch: (url, options) => fetch(url, options),
  parse: markup => new DOMParser().parseFromString(markup, "text/html"),
  onError: error => console.error("Runmesh navigation failed", error),
});
if (new URLSearchParams(location.search).has("lang")) locale.rememberLocale(locale.requestedLocale());
locale.applyLocale(locale.requestedLocale());
bindPage(document);
navigation.initialize();
window.addEventListener("beforeunload", () => navigation.retire());
window.addEventListener("resize", () => controls.stabilizeTabPanels(document));
window.addEventListener("popstate", () => { void navigation.open(new URL(location.href), false); });
