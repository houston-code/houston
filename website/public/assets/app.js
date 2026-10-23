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

  // The GPU name, and whether WebGL offers ASTC textures (only Apple's own GPUs do), which
  // on a Mac are the only non-Chromium hints of the CPU. Read locally and never sent
  // anywhere.
  function webglHints() {
    try {
      var canvas = document.createElement("canvas");
      var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) return { gpu: "", astc: false };
      var ext = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        gpu: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || ""),
        astc: !!gl.getExtension("WEBGL_compressed_texture_astc"),
      };
    } catch (e) {
      return { gpu: "", astc: false };
    }
  }

  function gatherSignals() {
    var signals = {
      ua: navigator.userAgent || "",
      platform: navigator.platform || "",
      touchPoints: navigator.maxTouchPoints || 0,
      uaArch: "",
      gpu: "",
      astc: false,
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
      if (isMac && !signals.uaArch) {
        var webgl = webglHints();
        signals.gpu = webgl.gpu;
        signals.astc = webgl.astc;
      }
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
    // Every card's button starts as primary, so with no clear pick all four read as
    // equally good choices. Once one card is recommended, the others step back.
    $all(".dl-card").forEach(function (other) {
      if (other === card) return;
      var button = $(".dl-primary", other);
      if (button) { button.classList.remove("btn-primary"); button.classList.add("btn-secondary"); }
    });
    recommended = $(".dl-primary", card);
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
    var versionLink = $("#hero-version");
    if (version && versionLink) {
      versionLink.href = /^https:\/\//.test(release.html_url || "") ? release.html_url : RELEASES_PAGE;
      versionLink.textContent = "v" + version + " release notes";
      versionLink.hidden = false;
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

  // ---- Copy buttons on the CLI install commands ----
  // The buttons ship hidden, so a browser without the async clipboard (or without
  // JavaScript) shows none that can't work; each command still selects in one click.
  // When the browser refuses the write, the command is selected and the older copy
  // command tried; if that fails too, the selection stays for Cmd/Ctrl+C.
  function selectText(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    var copyStatus = $("#copy-status");
    $all(".copy-btn").forEach(function (btn) {
      var code = btn.parentNode.querySelector("code");
      if (!code) return;
      var label = btn.textContent;
      var reset = null;
      function show(text, status) {
        btn.textContent = text;
        if (copyStatus) copyStatus.textContent = status;
        clearTimeout(reset);
        reset = setTimeout(function () {
          btn.textContent = label;
          if (copyStatus) copyStatus.textContent = "";
        }, 1500);
      }
      btn.hidden = false;
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(code.textContent).then(
          function () { show("Copied", "Command copied."); },
          function () {
            selectText(code);
            var copied = false;
            try { copied = document.execCommand("copy"); } catch (e) { copied = false; }
            if (copied) show("Copied", "Command copied.");
            else show("Selected", "Command selected. Press Ctrl+C or Cmd+C to copy it.");
          }
        );
      });
    });
  }

  // Only the landing page has links or a version to fill in. Anywhere else the call would
  // just spend the visitor's unauthenticated GitHub API allowance (60 an hour per IP),
  // which the landing page then needs for its direct download links.
  var wantsRelease = !!($("[data-asset-suffix]") || $("#hero-version"));
  if (window.fetch && wantsRelease) {
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
