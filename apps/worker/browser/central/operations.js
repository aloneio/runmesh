/** UI admission is scoped to one connection or workflow; library reads fence foreground actions. */
export function createCentralOperations({ app, isCurrent, reportError, working }) {
  const active = new Map(), locked = new Map(), waiting = new Set();
  let activity = 0;
  function scopeOf(control) {
    return control.getAttribute?.('data-operation-scope')
      ?? control.closest?.('[data-operation-scope]')?.getAttribute('data-operation-scope');
  }
  function sync() {
    const foreground = [...active.values()].some(operation => !operation.background);
    app.setAttribute('aria-busy', String(foreground));
    app.querySelectorAll('button,input,select').forEach(control => {
      const scope = scopeOf(control);
      const disabled = active.has('library') || active.has(scope)
        || scope === 'library' && foreground;
      if (disabled) {
        if (!locked.has(control)) locked.set(control, control.disabled);
        control.disabled = true;
      } else if (locked.has(control)) {
        control.disabled = locked.get(control);
        locked.delete(control);
      }
    });
    for (const control of locked.keys()) if (!control.isConnected) locked.delete(control);
  }
  function blocked(scope) {
    return active.has(scope) || active.has('library')
      || scope === 'library' && [...active.values()].some(operation => !operation.background);
  }
  async function run(action, scope, { background = false, onError = reportError } = {}) {
    // Recovery waits behind a user action; a second click never queues a stale write.
    while (background && isCurrent() && blocked(scope)) {
      await new Promise(resolve => waiting.add(resolve));
    }
    if (!isCurrent() || blocked(scope)) return;
    active.set(scope, { background });
    if (!background) activity++;
    sync();
    if (!background) working();
    try { return await action(); }
    catch (error) { if (isCurrent()) onError(error); }
    finally {
      active.delete(scope);
      sync();
      const ready = [...waiting]; waiting.clear(); ready.forEach(resolve => resolve());
    }
  }
  return { run, sync, activity: () => activity, interacted: () => { activity++; } };
}
