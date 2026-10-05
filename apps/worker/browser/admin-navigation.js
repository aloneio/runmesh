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
  let leaving = false;
  let activeController;
  const boundLinks = new WeakSet();
  const pageKey = url => url.pathname + url.search;
  let renderedPageKey = pageKey(new URL(location.href));
  function retire() {
    generation++;
    leaving = true;
    queued = undefined;
    activeController?.abort();
  }
  function navigate(url) {
    const destination = new URL(url, location.href);
    retire();
    location.href = destination.href;
  }
  function navigateFully(url) {
    navigate(queued?.url ?? url);
  }
  async function open(url, shouldPush) {
    if (leaving) {
      navigate(url);
      return;
    }
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
    activeController = controller;
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url.href, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal
      });
      if (leaving) return;
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
      renderedPageKey = pageKey(url);
    } catch (error) {
      if (!leaving) {
        onError(error);
        navigateFully(url);
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (activeController === controller) activeController = undefined;
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
    replaceCurrentUrl(url) {
      if (loading || leaving) return false;
      const current = new URL(location.href), destination = new URL(url, current);
      // Canonicalizing the current page must not impersonate a page transition.
      if (destination.origin !== current.origin || destination.pathname !== current.pathname) return false;
      const key = pageKey(destination);
      view.replaceCurrentUrl(destination, key);
      renderedPageKey = key;
      return true;
    },
    restore(url) {
      // Native fragment navigation owns its focus, scroll and history. Keep
      // the current forms unless a pending transition already retired them.
      if (!loading && !leaving && pageKey(url) === renderedPageKey) return;
      return open(url, false);
    },
    navigate,
    retire,
    bind,
    isLoading: () => loading,
    capturePage() {
      const pageGeneration = generation;
      return () => !leaving && pageGeneration === generation;
    },
    initialize() {
      view.initialize();
      bind(document);
      view.ready();
    }
  };
}
