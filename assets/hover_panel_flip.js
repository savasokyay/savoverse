// WP-83: Static-export film-hover-panel — flip to the LEFT of the poster
// when it would overflow past the viewport's right edge or run into the
// legend panel, mirroring what the live app's Popper-positioned dbc.Tooltip
// already does automatically (confirmed live: it flips to bs-tooltip-start
// on its own). .film-hover-panel has no positioning engine of its own in
// static — assets/app.css just anchors it left:100% of the poster,
// unconditionally rightward — this fills that one gap with the smallest
// possible JS, computed fresh on every hover (not once at load) so it stays
// correct across window resizes.
//
// Scoped to .spage (only present in the static shell, per the existing
// .film-hover-panel CSS's own comment) so this is inert if this file is
// ever loaded by the live app too (Dash auto-serves every assets/*.js
// file) — the live app's real Popper already handles this on its own.
//
// This exact file is copied into the static HTML export and loaded via
// <script src="assets/hover_panel_flip.js"> (see export_static.py's
// _copy_assets()/shell <head>) — referenced, not duplicated, same pattern
// as assets/showtime_toggle.js.
(function () {
  "use strict";

  document.addEventListener("mouseover", function (ev) {
    var wrap = ev.target && ev.target.closest ? ev.target.closest(".spage .film-hover-wrap") : null;
    if (!wrap) return;
    var panel = wrap.querySelector(".film-hover-panel");
    if (!panel) return;

    // visibility:hidden (not display:none) keeps the panel in normal layout
    // flow, so its natural (unflipped) position is measurable at any time,
    // not just while actually revealed — reset first in case a previous
    // hover (before a resize, or on the same element) left it flipped.
    panel.classList.remove("flip-left");
    var rect = panel.getBoundingClientRect();
    var legend = document.querySelector(".sleg");
    var rightBound = legend ? legend.getBoundingClientRect().left : window.innerWidth;
    if (rect.right > rightBound) {
      panel.classList.add("flip-left");
    }
  });
})();
