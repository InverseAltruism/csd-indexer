// A stand-in for cairn's /header.js: it replaces the placeholder's children, as the real one does, and notes whether
// window.CairnTheme (theme.js) was loaded before it ran.
(() => {
  const h = document.getElementById("site-header");
  if (!h) return;
  h.dataset.sawTheme = String(!!window.CairnTheme);
  h.innerHTML = '<a class="sh-brand" href="/">Explorer</a>';
})();
