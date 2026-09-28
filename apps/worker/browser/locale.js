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
  return {
    applyLocale,
    requestedLocale,
    rememberLocale
  };
}
export { createLocale };
