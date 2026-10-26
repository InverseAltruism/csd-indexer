// A stand-in for cairn's /ui/avatar.js with only the two exports explorer.html calls: identitySeed (a primary name, else
// the address in lower case, as the real one) and avatarHtml, whose span carries its seed in data-seed so a test can read
// which seed was drawn. The real gradient is tested in cairn.
export function identitySeed(primaryName, address) {
  const name = typeof primaryName === "string" ? primaryName.trim() : "";
  if (name) return name;
  return typeof address === "string" ? address.toLowerCase() : "";
}
export function avatarHtml(seed, extraClass = "") {
  const s = String(seed).replace(/[^a-z0-9x-]/gi, "");
  return `<span class="ui-avatar ${extraClass}" data-seed="${s}" style="background:conic-gradient(from 90deg, rgb(110 130 230), rgb(230 140 180), rgb(110 130 230))" aria-hidden="true"></span>`;
}
