const bound = new WeakSet();

/** A failed destructive action stays beside its form. Never replay a POST:
 * successful actions and expired sessions navigate with a fresh GET only. */
export function bindRunnerActions(root) {
  root.querySelectorAll('form[data-runner-danger-action]').forEach(form => {
    if (bound.has(form)) return;
    bound.add(form);
    let pending = false;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending) return;
      const action = new URL(event.submitter?.getAttribute('formaction') || form.action, location.href);
      if (action.origin !== location.origin || !new RegExp('^/admin/runners/[A-Za-z0-9._:-]+/(delete|revoke)$').test(action.pathname)) return;
      const body = new URLSearchParams(new FormData(form));
      const controls = Array.from(form.querySelectorAll('button,input'));
      const disabled = controls.map(control => control.disabled);
      const notice = form.querySelector('[data-runner-action-feedback]');
      const unknown = document.documentElement.lang === 'zh-CN'
        ? '未能确认操作结果。请刷新 Runner 列表查看状态。'
        : 'The outcome could not be confirmed. Refresh the Runner list to check its status.';
      pending = true;
      form.setAttribute('aria-busy', 'true');
      controls.forEach(control => { control.disabled = true; });
      notice.hidden = true;
      notice.textContent = '';
      try {
        const response = await fetch(action.href, { method: 'POST', body, credentials: 'same-origin', cache: 'no-store' });
        if (!form.isConnected) return;
        const destination = new URL(response.url, location.href);
        if (response.redirected && destination.origin === location.origin
          && ['/', '/login', '/admin', '/admin/runners'].includes(destination.pathname)) {
          // Do not mistake a failed redirected dashboard read for a failed write.
          location.href = destination.href;
          return;
        }
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const message = page.querySelector('[data-admin-error]')?.textContent?.trim();
        notice.textContent = message || unknown;
        notice.hidden = false;
      } catch {
        notice.textContent = unknown;
        notice.hidden = false;
      } finally {
        // A user may have navigated away while the request was pending.
        // Re-enabling this form never issues another mutation.
        pending = false;
        form.removeAttribute('aria-busy');
        controls.forEach((control, index) => { control.disabled = disabled[index]; });
      }
    });
  });
}
