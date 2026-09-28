function copyText(text, {
  document,
  navigator
}) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  var area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } catch (_) {}
  area.remove();
  return Promise.resolve();
}
function copyValue(button) {
  var panel = button.hasAttribute("data-copy-source") && button.closest("[role=tabpanel]");
  if (panel) {
    var code = panel.querySelector("pre code");
    return code ? code.textContent || "" : "";
  }
  var value = button.getAttribute("data-copy");
  return value === null ? "" : value;
}
export { copyText, copyValue };
