// A stand-in for cairn's /charts/chart.js with only the exports explorer.html calls, so test/explorer-browser.test.ts
// checks the explorer's wiring (what it passes, where it puts the results, when it mounts and destroys) without
// cairn's tree. Its outputs are plain markers of its inputs; the real module's rendering is tested in cairn.
export const SAFETRADE_URL = "https://safetrade.com/exchange/CSD-USDT";

export const fmtUsd = (v) => String(Number(v));

export function csdRate(body) {
  const r = Number(body?.price?.last);
  if (!body || body.ok !== true || !(r > 0)) return null;
  return { rate: r, source: body.price.source === "coinpaprika" ? "CoinPaprika" : "SafeTrade", stale: !!body.stale, ageSecs: Number(body.ageSecs) || 0 };
}

export function rateEl(rate, _fmt, _now, basis) {
  const span = document.createElement("span");
  span.textContent = `rate: ${basis} · ${rate.source}${rate.stale ? ` · stale ${rate.ageSecs}s` : ""}`;
  return span;
}

export function hashrateWindowText(miners, series) {
  const n = series && Array.isArray(series.points) ? series.points.length : 0;
  if (n) return `series of ${n} points`;
  return miners ? `blocks ${miners.from_height} to ${miners.to_height}` : "";
}

// Counts the mounts not yet destroyed, so a test can see a replaced view's charts released.
globalThis.__chartStubLive = 0;

/** A `.cc` root with a note, a plot pane laid out in a table (as the real library does) and an empty-state line. */
export async function mountChart(host, opts) {
  let o = { points: [], staleSecs: null, emptyText: "", ...opts };
  globalThis.__chartStubLive++;
  // the real module reads its colours from the host's --chart-* tokens once, here, at mount
  const line = getComputedStyle(host).getPropertyValue("--chart-line").trim();
  const draw = () => {
    host.replaceChildren();
    const root = document.createElement("div");
    root.className = "cc";
    const note = document.createElement("span");
    note.className = "cc-note";
    note.textContent = o.staleSecs == null ? "" : `stale ${o.staleSecs}s`;
    root.append(note);
    if (o.points.length) {
      const plot = document.createElement("div");
      plot.className = "cc-plot";
      // The library's layout (lightweight-charts, measured 2026-10-19): one table row of an empty left-axis cell, the
      // pane cell (position relative, a pixel width) holding a full-size box with the canvas, and the right-axis cell.
      // explorer.html's td max-width caps the pane cell at 280 px unless the page undoes it under .cc-plot.
      const table = document.createElement("table");
      table.setAttribute("cellspacing", "0");
      const row = table.insertRow();
      const left = row.insertCell(), pane = row.insertCell(), axis = row.insertCell();
      for (const c of [left, pane, axis]) c.style.padding = "0";
      pane.style.position = "relative";
      pane.style.width = `${Math.max(0, host.clientWidth - 120)}px`;
      pane.style.height = "232px";
      const box = document.createElement("div");
      Object.assign(box.style, { width: "100%", height: "100%", position: "relative", overflow: "hidden" });
      const canvas = document.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.display = "block";
      canvas.dataset.label = o.label ?? "";
      canvas.dataset.points = String(o.points.length);
      canvas.dataset.line = line;
      // what the page asked for besides the points: labelled price lines, unlabelled extra lines (their levels), the domain
      canvas.dataset.priceLines = String((o.lines ?? []).length);
      canvas.dataset.extra = (o.extra ?? []).map((x) => `${x.points.map((p) => p[4]).join("/")}${x.dashed ? " dashed" : ""}`).join(";");
      canvas.dataset.domainHi = o.domain ? String(o.domain.hi) : "";
      box.append(canvas);
      pane.append(box);
      plot.append(table);
      root.append(plot);
    } else {
      const empty = document.createElement("div");
      empty.className = "cc-empty";
      empty.textContent = o.emptyText;
      root.append(empty);
    }
    host.append(root);
  };
  draw();
  return {
    async update(points, more = {}) { o = { ...o, ...more, points }; draw(); },
    destroy() { globalThis.__chartStubLive--; host.replaceChildren(); },
  };
}
