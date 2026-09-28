/** One navigation owner: coalesce destinations, always revalidate, never reuse stale forms. */
export function createAdminNavigation({
  document,
  location,
  fetch,
  parse,
  view,
  locale,
  onError
}) {
  let loading = false;
  let queued;
  const boundLinks = new WeakSet();
  const pageKey = url => url.pathname + url.search;
  async function open(url, shouldPush) {
    if (loading) {
      queued = {
        url,
        shouldPush
      };
      return;
    }
    loading = true;
    view.setLoading(true);
    try {
      const response = await fetch(url.href, {
        credentials: "same-origin",
        cache: "no-store"
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const parsed = parse(await response.text());
      if (parsed.documentElement?.lang && parsed.documentElement.lang !== locale.requestedLocale()) {
        location.href = url.href;
        return;
      }
      const next = parsed.querySelector("#main-content");
      if (!next) throw new Error("main content missing");
      const root = view.pageRoot(next);
      if (!root) throw new Error("page root missing");
      view.mount(root, parsed.title || "", pageKey(url), shouldPush, url);
    } catch (error) {
      onError(error);
      location.href = url.href;
    } finally {
      loading = false;
      view.setLoading(false);
      if (queued) {
        const destination = queued;
        queued = undefined;
        void open(destination.url, destination.shouldPush);
      }
    }
  }
  function bind(root) {
    root.querySelectorAll("a[href^=\"/admin\"]").forEach(link => {
      if (boundLinks.has(link)) return;
      boundLinks.add(link);
      link.addEventListener("click", event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute("download") || link.target === "_blank") return;
        const target = new URL(link.href, location.href);
        if (target.origin !== location.origin) return;
        if (target.pathname === location.pathname && target.search === location.search && target.hash) return;
        event.preventDefault();
        void open(target, pageKey(target) !== pageKey(new URL(location.href)));
      });
    });
  }
  return {
    open,
    bind,
    isLoading: () => loading,
    initialize() {
      view.initialize();
      bind(document);
      view.ready();
    }
  };
}
