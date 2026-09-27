/** DOM primitives and presentation; writes are serialized by the controller. */
export function createCentralView(app, t, run) {
  var status = app.querySelector("[data-product-status]");
  function el(tag, text, className) {
    var n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (className) n.className = className;
    return n;
  }
  function say(text, error) {
    status.textContent = text;
    status.setAttribute('data-error', String(!!error));
  }
  function button(parent, label, action) {
    var b = el('button', label, 'button small secondary');
    b.type = 'button';
    b.addEventListener('click', function () {
      run(action);
    });
    parent.appendChild(b);
    return b;
  }
  function clear(node) {
    node.replaceChildren();
  }
  function details(parent, title, text) {
    var d = el('details'),
      s = el('summary', title),
      p = el('pre', text);
    d.append(s, p);
    parent.appendChild(d);
  }
  function invalidate() {
    app.querySelectorAll('[data-service-tools],[data-skill-review]').forEach(function (n) {
      clear(n);
      n.hidden = true;
    });
  }
  function showTab(name) {
    app.querySelectorAll('[data-central-tab]').forEach(function (b) {
      var active = b.getAttribute('data-central-tab') === name;
      b.setAttribute('aria-pressed', String(active));
      b.classList.toggle('secondary', !active);
    });
    app.querySelectorAll('[data-central-panel]').forEach(function (p) {
      p.hidden = p.getAttribute('data-central-panel') !== name;
    });
  }
  return {
    el,
    say,
    button,
    clear,
    details,
    invalidate,
    showTab
  };
}
