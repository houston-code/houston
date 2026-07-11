/* Houston site — progressive enhancement.
   Populates download links + version from the public GitHub Releases feed,
   and highlights the visitor's platform. Everything degrades gracefully:
   with no network the pre-rendered links point at the releases page. */

(function () {
  "use strict";

  var RELEASES_REPO = "piyushvijay/houston-releases";
  var RELEASES_API = "https://api.github.com/repos/" + RELEASES_REPO + "/releases/latest";
  var RELEASES_PAGE = "https://github.com/" + RELEASES_REPO + "/releases/latest";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // Current year in the footer.
  var yearEl = $("#year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ---- Platform detection (best effort; browsers can't distinguish mac arch) ----
  function detectOS() {
    var ua = navigator.userAgent || "";
    var plat = navigator.platform || "";
    if (/Win/.test(plat) || /Windows/.test(ua)) return "win";
    if (/Linux/.test(plat) && !/Android/.test(ua)) return "linux";
    if (/Mac/.test(plat) || /Mac OS X/.test(ua)) return "mac-arm";
    return null;
  }

  var os = detectOS();
  var HERO_LABEL = { "mac-arm": "Download for macOS", "mac-x64": "Download for macOS", win: "Download for Windows", linux: "Download for Linux" };
  var heroLabel = $("#hero-download-label");
  if (os && heroLabel && HERO_LABEL[os]) heroLabel.textContent = HERO_LABEL[os];

  // Emphasize the visitor's platform card.
  if (os) {
    var card = $('.dl-card[data-os="' + os + '"]');
    if (card) {
      card.classList.add("is-recommended");
      var badge = document.createElement("span");
      badge.className = "dl-badge";
      badge.textContent = "Recommended for you";
      card.insertBefore(badge, card.firstChild);
      var primary = $(".dl-primary", card);
      if (primary) { primary.classList.remove("btn-secondary"); primary.classList.add("btn-primary"); }
    }
  }

  // ---- Live release data ----
  function applyRelease(release) {
    if (!release || !Array.isArray(release.assets)) return;

    var version = (release.tag_name || release.name || "").replace(/^v/i, "");
    if (version) {
      var meta = $("#hero-version");
      if (meta) meta.innerHTML = "Latest release <strong>v" + escapeHtml(version) + "</strong> · free, bring your own API keys.";
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
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
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
        // pre-rendered links to the releases page.
        clear();
        var meta = $("#hero-version");
        if (meta) meta.innerHTML =
          'Free and open — bring your own API keys. <a href="' + RELEASES_PAGE + '" rel="noopener">See all releases</a>.';
      });
  }
})();
