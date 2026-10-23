/* Houston site: light/dark choice. Loaded un-deferred in <head> so a pinned theme is
   applied before first paint (the CSP forbids inline scripts). With no stored choice,
   or no JS, the site follows the OS through prefers-color-scheme. */

(function () {
  "use strict";

  var KEY = "houston-theme";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
  if (stored === "light" || stored === "dark") root.setAttribute("data-theme", stored);

  function isDark() {
    var pinned = root.getAttribute("data-theme");
    return pinned ? pinned === "dark" : !!(media && media.matches);
  }

  // The media query for things that come in a light and a dark copy: the OS scheme,
  // or with a pinned theme, always on for that theme and always off for the other.
  function themedMedia(scheme) {
    var pinned = root.getAttribute("data-theme");
    return pinned ? (pinned === scheme ? "all" : "not all") : "(prefers-color-scheme: " + scheme + ")";
  }

  // Screenshots come in a light and a dark capture inside <picture>, and the browser's
  // toolbar color in a light and a dark theme-color <meta>. With no pinned theme both
  // follow the OS on their own; a pinned theme forces them on or off, so the screenshot
  // and the toolbar always match the page.
  function syncMedia() {
    var sources = document.querySelectorAll('source[data-theme-source="dark"]');
    for (var i = 0; i < sources.length; i++) sources[i].setAttribute("media", themedMedia("dark"));
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var j = 0; j < metas.length; j++) {
      // Each meta's scheme is read from its media query once, before that is rewritten.
      if (!metas[j].hasAttribute("data-scheme")) {
        metas[j].setAttribute("data-scheme", /dark/.test(metas[j].getAttribute("media") || "") ? "dark" : "light");
      }
      metas[j].setAttribute("media", themedMedia(metas[j].getAttribute("data-scheme")));
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    syncMedia();
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    function sync() { button.setAttribute("aria-pressed", String(isDark())); syncMedia(); }
    button.hidden = false;
    sync();
    button.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* storage blocked */ }
      sync();
    });
    if (media && media.addEventListener) media.addEventListener("change", sync);
  });
})();
