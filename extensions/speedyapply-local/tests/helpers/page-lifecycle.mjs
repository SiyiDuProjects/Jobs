// JSDOM removes its document on close; a real document's observers are destroyed
// with the execution context. Disconnect them first to reproduce that boundary.
export function installPageLifecycle(window) {
  const observers = new Set(),
    Original = window.MutationObserver,
    close = window.close.bind(window);
  window.MutationObserver = class extends Original {
    constructor(callback) {
      super(callback);
      observers.add(this);
    }
  };
  window.close = () => {
    for (const observer of observers) observer.disconnect();
    observers.clear();
    close();
  };
}
