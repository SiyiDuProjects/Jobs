// Observe the site's existing definition updates, without reading bodies,
// retaining URLs, issuing requests, or writing application answers.
export function installWorkdayCommitObserver(view = window) {
  const attribute = "data-jobs-form-commit";
  const doc = view.document;
  if (doc.documentElement?.hasAttribute(attribute)) return;
  const original = view.fetch;
  if (typeof original !== "function") return;
  let pending = 0,
    revision = 0,
    failed = false;
  const publish = () =>
    doc.documentElement?.setAttribute(
      attribute,
      JSON.stringify({ pending, revision, failed }),
    );
  const nextTask = (run) => {
    const channel = new view.MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      run();
    };
    channel.port2.postMessage(null);
  };
  const isDefinition = (input, init) => {
    try {
      const url = new URL(
        typeof input === "string" || input instanceof view.URL
          ? String(input)
          : input.url,
        view.location.href,
      );
      return (
        url.origin === view.location.origin &&
        /^\/wday\/cxs\/[^/]+\/jobapplication\/[^/]+\//.test(url.pathname) &&
        new view.Headers(init?.headers ?? input?.headers).get(
          "form-definition",
        ) === "true"
      );
    } catch {
      return false;
    }
  };
  view.fetch = async function (input, init) {
    if (!isDefinition(input, init))
      return Reflect.apply(original, this, [input, init]);
    if (!pending) failed = false;
    pending++;
    revision++;
    publish();
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      // The consumer's await/json continuation republishes Workday form state.
      // Cross a task boundary before allowing another field to change it.
      nextTask(() => {
        pending--;
        failed ||= !ok;
        revision++;
        publish();
      });
    };
    try {
      const response = await Reflect.apply(original, this, [input, init]);
      if (!response.ok) {
        finish(false);
        return response;
      }
      const json = response.json;
      try {
        response.json = async function () {
          try {
            const data = await Reflect.apply(json, this, []);
            finish(true);
            return data;
          } catch (error) {
            finish(false);
            throw error;
          }
        };
      } catch {
        // Instrumentation must not turn a valid site response into an error.
        finish(false);
      }
      return response;
    } catch (error) {
      finish(false);
      throw error;
    }
  };
  publish();
  doc.addEventListener("readystatechange", publish, { once: true });
}
