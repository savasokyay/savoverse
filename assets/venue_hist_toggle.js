// WP-88: Static export — "Last 30 days of watching" unit-square histogram,
// venue-emoji label toggle (🏷 button; live app equivalent: WP-46 clientside
// callback #19 in src/ui/callbacks.py).
//
// Delegated, document-level listener — same reasoning as assets/cinema_map_toggle.js
// and assets/showtime_toggle.js: survives re-renders in the live Dash app, and costs
// nothing extra in the static export where the DOM is fixed.
//
// The live callback looks up the graph via a Dash-assigned id
// ("venue-hist-30d-graph"). That id does NOT survive static export — dcc.Graph
// components get a re-numbered "fig-N" div id there instead (see
// scripts/export_static.py's _component_to_html(), Graph branch). So this
// listener finds the figure structurally instead: closest .plot-card ancestor
// -> its one .js-plotly-plot child (same pattern already used by the two files
// referenced above).
//
// This exact file is copied into the static HTML export and loaded via
// <script src="assets/venue_hist_toggle.js"> (see export_static.py's
// _copy_assets()/shell <head>) — referenced, not duplicated, since it has
// zero Dash-specific dependencies (plain DOM + Plotly.js APIs only).
(function () {
  "use strict";

  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest(".plot-label-toggle-btn") : null;
    if (!btn) return;

    var card = btn.closest(".plot-card");
    var gd = card ? card.querySelector(".js-plotly-plot") : null;
    if (!gd || !gd.data || !window.Plotly) return;

    var active = !btn.classList.contains("active");
    btn.classList.toggle("active", active);

    // Mirrors src/ui/callbacks.py callback #19 exactly: transparent when off,
    // 85%-white when on.
    var color = active ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0)";
    Plotly.restyle(gd, { "textfont.color": color });
  });
})();
