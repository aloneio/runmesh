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
  let generation = 0;
  const boundLinks = new WeakSet();
  const pageKey = url => url.pathname + url.search;
  function navigateFully(url) {
    generation++;
    const destination = queued?.url ?? url;
    queued = undefined;
    location.href = destination.href;
  }
  async function open(url, shouldPush) {
    // A new destination retires the old page immediately, including while
    // its DOM remains visible during loading or a full-navigation fallback.
    generation++;
    if (loading) {
      queued = {
        url,
        shouldPush
      };
      return;
    }
    loading = true;
    view.setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url.href, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const markup = await response.text();
      controller.signal.throwIfAborted();
      const parsed = parse(markup);
      if (parsed.documentElement?.lang && parsed.documentElement.lang !== locale.requestedLocale()) {
        navigateFully(url);
        return;
      }
      // A newer destination owns both the page and history. Mounting this response
      // would also start controllers for a page the user has already left.
      if (queued) return;
      const next = parsed.querySelector("#main-content");
      if (!next) throw new Error("main content missing");
      const root = view.pageRoot(next);
      if (!root) throw new Error("page root missing");
      view.mount(root, parsed.title || "", pageKey(url), shouldPush, url);
    } catch (error) {
      onError(error);
      navigateFully(url);
    } finally {
      clearTimeout(timer);
      controller.abort();
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
    capturePage() {
      const pageGeneration = generation;
      return () => pageGeneration === generation;
    },
    initialize() {
      view.initialize();
      bind(document);
      view.ready();
    }
  };
}
