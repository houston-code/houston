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

  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    function sync() { button.setAttribute("aria-pressed", String(isDark())); }
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
