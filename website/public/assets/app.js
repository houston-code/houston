/* Houston site — progressive enhancement.
   Populates download links + version from the public GitHub Releases feed,
   and highlights the visitor's platform. Everything degrades gracefully:
   with no network the pre-rendered links point at the releases page. */

(function () {
  "use strict";

  var RELEASES_REPO = "houston-code/houston";
  var RELEASES_API = "https://api.github.com/repos/" + RELEASES_REPO + "/releases/latest";
  var RELEASES_PAGE = "https://github.com/" + RELEASES_REPO + "/releases/latest";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // Current year in the footer.
  var yearEl = $("#year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ---- Platform detection (logic in platform.js; this gathers signals + applies it) ----
  var HERO_LABEL = { mac: "Download for macOS", win: "Download for Windows", linux: "Download for Linux" };

  // The GPU name, which on a Mac is the only non-Chromium hint of the CPU. Read locally
  // and never sent anywhere.
  function webglRenderer() {
    try {
      var canvas = document.createElement("canvas");
      var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) return "";
      var ext = gl.getExtension("WEBGL_debug_renderer_info");
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
    } catch (e) {
      return "";
    }
  }

  function gatherSignals() {
    var signals = {
      ua: navigator.userAgent || "",
      platform: navigator.platform || "",
      touchPoints: navigator.maxTouchPoints || 0,
      uaArch: "",
      gpu: "",
    };
    var isMac = /Mac/.test(signals.platform) || /Mac OS X/.test(signals.ua);
    var uaData = navigator.userAgentData;
    var hints = uaData && typeof uaData.getHighEntropyValues === "function"
      ? uaData.getHighEntropyValues(["architecture"]).then(
          function (v) { signals.uaArch = (v && v.architecture) || ""; },
          function () {}
        )
      : Promise.resolve();
    return hints.then(function () {
      if (isMac && !signals.uaArch) signals.gpu = webglRenderer();
      return signals;
    });
  }

  function applyPlatform(result) {
    var heroLabel = $("#hero-download-label");
    if (result.os && heroLabel && HERO_LABEL[result.os]) heroLabel.textContent = HERO_LABEL[result.os];

    // No card fits (a Mac we can't place, Linux on Arm): reveal the note that explains
    // what to get, rather than recommend a build that may not run.
    if (result.hint) {
      var hint = document.getElementById(result.hint);
      if (hint) hint.hidden = false;
    }

    // Emphasize the visitor's platform card.
    if (!result.card) return;
    var card = $('.dl-card[data-os="' + result.card + '"]');
    if (!card) return;
    card.classList.add("is-recommended");
    // The head row is in every card, so the badge fills space already reserved for it.
    var badge = document.createElement("span");
    badge.className = "dl-badge";
    badge.textContent = "Recommended";
    ($(".dl-head", card) || card).appendChild(badge);
    var primary = $(".dl-primary", card);
    if (primary) { primary.classList.remove("btn-secondary"); primary.classList.add("btn-primary"); }
    recommended = primary;
    syncHeroDownload();
  }

  // The hero button downloads the recommended build directly, but only once both halves
  // are known: which card fits (platform detection) and that card's real file URL (the
  // release feed). Until then, or if either never arrives, it scrolls to the cards.
  var recommended = null;
  function syncHeroDownload() {
    var hero = $("#hero-download");
    if (!hero || !recommended || !recommended.hasAttribute("data-resolved")) return;
    hero.setAttribute("href", recommended.getAttribute("href"));
  }

  // Only the landing page loads platform.js; other pages have no download cards.
  if (window.HoustonPlatform && window.Promise) {
    gatherSignals().then(function (signals) { applyPlatform(window.HoustonPlatform.classify(signals)); });
  }

  // ---- Live release data ----
  function applyRelease(release) {
    if (!release || !Array.isArray(release.assets)) return;

    var version = (release.tag_name || release.name || "").replace(/^v/i, "");
    var versionItem = $("#hero-version");
    if (version && versionItem) {
      var link = document.createElement("a");
      link.href = /^https:\/\//.test(release.html_url || "") ? release.html_url : RELEASES_PAGE;
      link.rel = "noopener";
      link.textContent = "v" + version;
      link.setAttribute("aria-label", "Latest release, version " + version + ", release notes");
      versionItem.appendChild(link);
      versionItem.hidden = false;
    }

    // Map each pre-rendered link (by asset-name suffix) to its direct download URL.
    $all("[data-asset-suffix]").forEach(function (el) {
      var suffix = el.getAttribute("data-asset-suffix");
      var match = release.assets.filter(function (a) {
        return typeof a.name === "string" && a.name.slice(-suffix.length) === suffix;
      })[0];
      // Only trust https URLs — never let an API value become a javascript: href.
      if (match && /^https:\/\//.test(match.browser_download_url || "")) {
        el.setAttribute("href", match.browser_download_url);
        el.setAttribute("data-resolved", "");
      }
    });
    syncHeroDownload();
  }

  if (window.fetch) {
    // Abort after 6s so a slow or unreachable GitHub API falls back fast.
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;
    function clear() { if (timer) { clearTimeout(timer); timer = null; } }
    fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (r) { clear(); return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
      .then(applyRelease)
      .catch(function () {
        // Offline, rate-limited, no releases yet, or timed out: keep the
        // pre-rendered links to the releases page, and show no version.
        clear();
      });
  }
})();
