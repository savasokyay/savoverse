// WP-70: Cinema — "showings by part of day" bars <-> 24h clock panel toggle.
//
// Delegated, document-level listener (survives module re-renders — the whole
// card is torn down/rebuilt every time the page is navigated to, so a
// listener bound directly to the button at render time would be lost the
// next time Dash re-renders it). Dash auto-serves every assets/*.js file; no
// registration needed elsewhere.
//
// Unlike assets/cinema_map_toggle.js (WP-62), this does NOT call
// Plotly.restyle() on trace visibility — both panels here are genuinely
// different figures (a cartesian dual-axis chart vs. a polar clock), not one
// figure with two sets of traces sharing a layout. Both panels' figures ship
// fully built in the DOM; this listener only flips a class on the .plot-card,
// CSS does the actual showing/hiding (see assets/app.css), and this then
// resizes whichever panel was just revealed — a chart rendered under
// display:none sizes itself against a zero-width box, so Plotly.Plots.resize()
// is needed once the panel becomes visible. Neither panel has pan/zoom state
// to preserve (6 fixed categories; a fixed-radius clock), which is exactly
// the state WP-62's restyle-only approach exists to protect — that constraint
// doesn't apply here, so there is nothing to lose from a plain visibility swap.
//
// This exact file is copied into the static HTML export and loaded via
// <script src="assets/showtime_toggle.js"> (see export_static.py's
// _copy_assets()/shell <head>) — referenced, not duplicated, since it has
// zero Dash-specific dependencies (plain DOM + Plotly.js APIs only).
(function () {
  "use strict";

  document.addEventListener("click", function (ev) {
    var wrap = ev.target && ev.target.closest ? ev.target.closest(".showtime-mode-toggle-wrap") : null;
    if (!wrap) return;

    var card = wrap.closest(".plot-card");
    if (!card) return;

    var toClock = !card.classList.contains("clock-mode");
    card.classList.toggle("clock-mode", toClock);

    var panel = card.querySelector(toClock ? ".showtime-panel-clock" : ".showtime-panel-bars");
    if (!panel || !window.Plotly) return;

    // Double-RAF: let the display:none -> block flip settle so
    // Plotly.Plots.resize() reads the real container box (same pattern as
    // export_static.py's showPage()).
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var graphs = panel.querySelectorAll(".js-plotly-plot");
        graphs.forEach(function (gd) {
          try { Plotly.Plots.resize(gd); } catch (e) { /* not a plotly div yet, ignore */ }
        });
      });
    });
  });
})();
