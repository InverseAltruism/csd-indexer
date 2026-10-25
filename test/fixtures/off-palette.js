// The design direction's colour rule measured in the page (test/explorer-browser.test.ts evaluates this file's text):
// every visible colour under the view is achromatic or one of --ui-up, --ui-down, --ui-warn at any alpha. Returns the
// offending elements and colours. Plain JavaScript read as text, so the test transpiler adds nothing the page lacks.
(() => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  // OKLab chroma: below 0.03 a colour reads as grey
  const chroma = ({ r, g, b }) => {
    const R = lin(r), G = lin(g), B = lin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
  };
  const probe = document.createElement("span");
  document.body.append(probe);
  const tok = (n) => { probe.style.color = `var(${n})`; return parse(getComputedStyle(probe).color); };
  const allowed = ["--ui-up", "--ui-down", "--ui-warn"].map(tok);
  probe.remove();
  const out = new Set();
  for (const el of document.querySelectorAll("#view *, #stats *")) {
    const r = el.getBoundingClientRect(), st = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || st.visibility === "hidden") continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    for (const c of [own ? st.color : "", st.backgroundColor, parseFloat(st.borderTopWidth) ? st.borderTopColor : ""]) {
      const p = c && parse(c);
      if (!p || p.a < 0.05 || chroma(p) < 0.03) continue;
      if (allowed.some((t) => t && Math.abs(t.r - p.r) <= 3 && Math.abs(t.g - p.g) <= 3 && Math.abs(t.b - p.b) <= 3)) continue;
      out.add(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${c}`);
    }
  }
  return [...out];
})()
