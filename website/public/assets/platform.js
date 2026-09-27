/* Houston site: work out which download card fits the visitor.
   Pure function over browser signals, so website/tools/platform.test.mjs can test it in
   Node. app.js gathers the signals and applies the result.

   Why it isn't just the user agent: every Mac browser reports "Intel Mac OS X", so the
   UA can't tell Apple Silicon from Intel. Chromium exposes the real CPU through
   User-Agent Client Hints; other browsers sometimes name the GPU via WebGL. When neither
   says, we recommend no Mac card instead of guessing, because the Apple Silicon build
   won't open on an Intel Mac. Linux on Arm gets no card either (there is no Linux arm64
   build) and a pointer to the standalone CLI, which runs anywhere Node does. */

(function (root) {
  "use strict";

  // signals: { ua, platform, uaArch ("arm" | "x86" | "" from Client Hints), gpu (WebGL renderer) }
  // returns: { os: "mac" | "win" | "linux" | null, card: data-os of the card to recommend, or null,
  //            hint: id of the note to reveal instead, when there is no card to recommend }
  function classify(signals) {
    var ua = signals.ua || "";
    var plat = signals.platform || "";
    var uaArch = signals.uaArch || "";
    var gpu = signals.gpu || "";

    if (/Win/.test(plat) || /Windows/.test(ua)) return { os: "win", card: "win" };
    if (/Linux/.test(plat) && !/Android/.test(ua)) {
      // Firefox reports "Linux aarch64" in navigator.platform; Chromium freezes its UA to
      // x86_64 but reports the real CPU through Client Hints.
      if (uaArch === "arm" || /aarch64|arm64|armv\d/i.test(plat + " " + ua)) {
        return { os: "linux", card: null, hint: "linux-arm-hint" };
      }
      return { os: "linux", card: "linux" };
    }
    if (/Mac/.test(plat) || /Mac OS X/.test(ua)) {
      // iPhone/iPad Safari also says "Mac OS X"; a touch-capable "Mac" is an iPad.
      if (/iPhone|iPad|iPod/.test(ua) || signals.touchPoints > 1) return { os: null, card: null };
      if (uaArch === "arm") return { os: "mac", card: "mac-arm" };
      if (uaArch === "x86") return { os: "mac", card: "mac-x64" };
      if (/Apple M\d/.test(gpu)) return { os: "mac", card: "mac-arm" };
      if (/Intel|AMD|Radeon|NVIDIA/i.test(gpu)) return { os: "mac", card: "mac-x64" };
      // Safari reports a generic "Apple GPU" on every Mac: no way to tell.
      return { os: "mac", card: null, hint: "mac-arch-hint" };
    }
    return { os: null, card: null };
  }

  var api = { classify: classify };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HoustonPlatform = api;
})(this);
