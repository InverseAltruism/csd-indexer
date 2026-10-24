// A stand-in for cairn's /ui/theme-init.js: the theme on <html> from the stored choice or the system, as the real one
// does. It also notes how many style sheets the page had when it ran (0: it ran before every sheet, so before the first
// paint).
(() => {
  let stored = null;
  try { stored = localStorage.getItem("cairn-theme"); } catch { /* storage blocked: the system decides */ }
  const dark = stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  document.documentElement.dataset.initSheets = String(document.styleSheets.length);
})();
