// Build supplies routes from the maintained adapter table, never a second list.
function jobsRuntimeBootstrap({
  build,
  routes,
  detailChecks = [],
  hostPatterns = [],
}) {
  let requested = false,
    observer,
    timer,
    lastUrl,
    candidates = [],
    urlMatch = false;
  const compiled = routes.map((route) => ({
    ...route,
    regexp: route.pattern ? new RegExp(route.pattern, route.flags) : null,
  }));
  const hosts = hostPatterns.map((pattern) => new RegExp(pattern));
  const matches = () => {
    if (lastUrl !== location.href) {
      lastUrl = location.href;
      urlMatch =
        compiled.some((route) => route.regexp?.test(lastUrl)) ||
        hosts.some((pattern) => pattern.test(location.hostname));
      candidates = compiled.filter((route) => route.selector);
    }
    // Keep the original pattern OR selector semantics, including custom domains.
    return (
      urlMatch ||
      candidates.some((route) => document.querySelector(route.selector)) ||
      detailChecks.some((check) => check(new URL(lastUrl)))
    );
  };
  const stop = () => {
    observer?.disconnect();
    clearInterval(timer);
    window.removeEventListener("popstate", check);
    window.removeEventListener("hashchange", check);
  };
  const notice = () => {
    const node = document.createElement("div");
    node.textContent = "Jobs 插件需要重新加载，请先保留当前申请内容。";
    node.setAttribute("role", "alert");
    (document.body || document.documentElement).append(node);
  };
  function check() {
    if (requested || !matches()) return;
    requested = true;
    stop();
    chrome.runtime
      .sendMessage({ type: "jobs:runtime-load", build })
      .then((result) => {
        if (!result?.ok) notice();
      }, notice);
  }
  observer = new MutationObserver(check);
  // URL changes made through history.pushState do not emit popstate. A cheap
  // URL/selector check catches SPA routes without patching the host page.
  const start = () => {
    if (requested) return;
    stop();
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-ph-id", "id", "href"],
    });
    timer = setInterval(check, 2000);
    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
    check();
  };
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", start);
  start();
}
