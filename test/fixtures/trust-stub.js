// A stand-in for cairn's /trade/discover.js with only trustLevel, the one export explorer.html calls, so
// test/explorer-browser.test.ts checks what the page passes it and how it words the answer; cairn tests the real rule.
// It answers by the same contract: a listed entry with a deployId is verified for that deploy only.
export function trustLevel({ ticker, meta = null, impersonated = new Set(), live = null }) {
  // a test names a level the real rule does not have yet (meta.level), to see the page show no badge for it
  if (meta?.level) return meta.level;
  if (meta) return !meta.deployId || (live && live.deployId === meta.deployId) ? "verified" : live ? "impersonator" : "unverified";
  return impersonated.has(String(ticker)) ? "impersonator" : "unverified";
}
