// WP-62: Cinema History — Cinema <-> Travel mode toggle.
//
// Delegated, document-level listener (survives module re-renders — the
// whole card is torn down/rebuilt every time the page is navigated to, so a
// listener bound directly to the button at render time would be lost the
// next time Dash re-renders it). Dash auto-serves every assets/*.js file;
// no registration needed elsewhere.
//
// Both modes' traces already ship in ONE figure (see
// src/modules/mod_cinema_map.py render()) — cinema traces start
// visible=true, travel traces start visible=false. This script only ever
// flips which set is visible, via Plotly.restyle() keyed on each trace's
// stable `name`. It deliberately NEVER touches layout.geo (center/
// projection_scale) — that's what preserves the user's current pan/zoom
// position across a toggle click, unlike rebuilding the figure would.
//
// This exact file is copied into the static HTML export and loaded via
// <script src="assets/cinema_map_toggle.js"> (see export_static.py's
// _copy_assets()/shell <head>) — referenced, not duplicated, since it has
// zero Dash-specific dependencies (plain DOM + Plotly.js APIs only).
(function () {
  "use strict";

  var CINEMA_TRACE_NAMES = ["cinema-countries", "travel-only-countries", "cinemas", "cinema-clusters"];
  var TRAVEL_TRACE_NAMES = ["travel-countries", "travel-unvisited", "travel-cities"];

  document.addEventListener("click", function (ev) {
    var wrap = ev.target && ev.target.closest ? ev.target.closest(".map-mode-toggle-wrap") : null;
    if (!wrap) return;

    var card = wrap.closest(".plot-card");
    if (!card) return;
    var gd = card.querySelector(".js-plotly-plot");
    if (!gd || !gd.data || !window.Plotly) return;

    var toTravel = !card.classList.contains("travel-mode");
    card.classList.toggle("travel-mode", toTravel);

    var visibleByName = {};
    CINEMA_TRACE_NAMES.forEach(function (n) { visibleByName[n] = !toTravel; });
    TRAVEL_TRACE_NAMES.forEach(function (n) { visibleByName[n] = toTravel; });

    var indices = [];
    var visibleValues = [];
    gd.data.forEach(function (trace, i) {
      if (Object.prototype.hasOwnProperty.call(visibleByName, trace.name)) {
        indices.push(i);
        visibleValues.push(visibleByName[trace.name]);
      }
    });
    if (indices.length) {
      Plotly.restyle(gd, { visible: visibleValues }, indices);
    }

    var titleEl = card.querySelector(".map-title");
    if (titleEl) {
      var next = toTravel ? titleEl.dataset.travelTitle : titleEl.dataset.cinemaTitle;
      if (next) titleEl.textContent = next;
    }
  });
})();
