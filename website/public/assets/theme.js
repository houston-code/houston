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

  // Screenshots come in a light and a dark capture inside <picture>. With no pinned
  // theme the dark <source> follows the OS on its own; a pinned theme forces it on or
  // off, so the screenshot always matches the page around it.
  function syncPictures() {
    var pinned = root.getAttribute("data-theme");
    var media = pinned ? (pinned === "dark" ? "all" : "not all") : "(prefers-color-scheme: dark)";
    var sources = document.querySelectorAll('source[data-theme-source="dark"]');
    for (var i = 0; i < sources.length; i++) sources[i].setAttribute("media", media);
  }

  document.addEventListener("DOMContentLoaded", function () {
    syncPictures();
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    function sync() { button.setAttribute("aria-pressed", String(isDark())); syncPictures(); }
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
