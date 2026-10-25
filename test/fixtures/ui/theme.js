// A stand-in for cairn's /ui/theme.js with only what the explorer and the header stub use: window.CairnTheme's set and
// onChange, and the cairn:theme event that set() fires after it writes data-theme.
(() => {
  if (window.CairnTheme) return;
  const EVENT = "cairn:theme";
  window.CairnTheme = Object.freeze({
    EVENT,
    set(choice) {
      document.documentElement.setAttribute("data-theme", choice);
      document.dispatchEvent(new CustomEvent(EVENT, { detail: { mode: choice, choice } }));
      return Promise.resolve();
    },
    onChange(listener) {
      const h = (e) => listener(e.detail);
      document.addEventListener(EVENT, h);
      return () => document.removeEventListener(EVENT, h);
    },
  });
})();
