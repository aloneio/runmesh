function createLocale({
  document
}) {
  function applyLocale(locale) {
    document.documentElement.lang = locale;
    document.querySelectorAll("[data-lang-toggle]").forEach(function (link) {
      link.setAttribute("aria-current", link.getAttribute("data-lang-toggle") === locale ? "true" : "false");
    });
  }
  function requestedLocale() {
    return document.documentElement.lang === "zh-CN" ? "zh-CN" : "en";
  }
  function rememberLocale(locale) {
    document.cookie = "runmesh_lang=" + locale + "; Max-Age=31536000; Path=/; SameSite=Lax";
  }
  function applyLocaleInPlace(locale) {
    // A POST result has no equivalent GET and its one-time command must stay
    // in this document. Only server-authored interface text is replaceable.
    if (!document.querySelector?.("#main-content[data-local-locale]")) return false;
    const suffix = locale === "zh-CN" ? "zh-cn" : "en";
    document.querySelectorAll("[data-locale-en]").forEach(function (element) {
      element.textContent = element.getAttribute("data-locale-" + suffix);
    });
    ["aria-label", "alt", "placeholder", "title", "data-password-show", "data-password-hide", "data-submit-pending"].forEach(function (name) {
      document.querySelectorAll("[data-locale-" + name + "-en]").forEach(function (element) {
        element.setAttribute(name, element.getAttribute("data-locale-" + name + "-" + suffix));
      });
    });
    applyLocale(locale);
    return true;
  }
  return {
    applyLocale,
    applyLocaleInPlace,
    requestedLocale,
    rememberLocale
  };
}
export { createLocale };
