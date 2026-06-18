// WP-92: Technical tab — three client-side interactions, no Dash callback /
// server round-trip for any of them (same no-callback philosophy as
// assets/showtime_toggle.js and assets/venue_hist_toggle.js).
//
// 1. Sort-mode toggle (.tech-sort-btn, data-mode="..." — 2 or more modes,
//    nothing here assumes exactly 2) — swaps which of N pre-rendered
//    .tech-sort-panel divs is visible. A CSS class flip, same mechanism as
//    showtime_toggle.js's bars<->clock panels — the modes select/order a
//    genuinely different entity set (or, for WP-93's dumbbell/Likert, a
//    different categorical DIMENSION), so all N ship fully built in the DOM
//    rather than being restyled from one.
//    WP-92 round 4: scoped to the nearest .tech-carousel-panel first (falls
//    back to .plot-card) — a bubble carousel panel's own toggle-row must
//    only affect ITS field's 2 sort-panels, not the other 4 fields sharing
//    the same card slot (they all live under one .plot-card).
//    WP-93: a card with data-sort-group="X" moves in lockstep with every
//    other card sharing that group value (same idea as #2's
//    data-carousel-group) — pairs WP-93's dumbbell + Likert cards so
//    switching one to e.g. "country" switches both.
//    BUG FIXED WP-93: every .tech-sort-btn shipped without the data-mode
//    attribute this handler reads (mod_tech_stats.py's buttons never set
//    it) — the whole Bayes<->Legacy toggle silently no-opped since WP-92
//    round 2 despite passing every prior click-through verification (the
//    verifications happened to eyeball the button's OWN highlight, which a
//    stray click still changes via :active/focus styling, not the actual
//    panel swap — a real lesson: verify the EFFECT the interaction is
//    supposed to have, not just that the control looks clicked).
//
// 2. Carousel prev/next (.tech-carousel-prev/-next) — cycles which of N
//    pre-rendered .tech-carousel-panel divs is visible inside a .tech-carousel
//    card, wrapping at both ends. WP-92 round 5: both carousel types (bar
//    and bubble) now bake a full title into each panel directly (see
//    mod_tech_stats.py) rather than sharing one updating header label, so
//    there's no per-panel label text to sync here anymore — showing/hiding
//    the right panel is enough. WP-92 round 4: a carousel with
//    data-carousel-group="X" moves in lockstep with every other
//    .tech-carousel sharing that group value — pairs the histogram carousel
//    with the bubble carousel so clicking either one's arrows advances both,
//    always showing the same field's two charts together. EXPERIMENTAL UI
//    (see mod_tech_stats.py's module docstring) — this file's carousel
//    handler is the piece to delete first if it doesn't pan out.
//
// 3. Color toggle (.tech-color-toggle) — a genuine Plotly.restyle(), unlike
//    1/2 above. Every bubble trace ships with BOTH color arrays precomputed
//    in trace.meta (ratingColors / devColors — see src/plots/bubble_plots.py)
//    since a per-point diverging color can't be derived from CSS alone.
//    WP-92 round 4: scoped to the nearest .tech-carousel-panel first (falls
//    back to .plot-card) — same reasoning as #1, so recoloring one carousel
//    field doesn't also restyle the other four hidden ones. Still applies to
//    EVERY .js-plotly-plot within that scope (both sort-mode panels,
//    including the currently-hidden one) so switching sort mode afterwards
//    doesn't silently revert the color choice.
//
// Delegated, document-level listener — survives Dash re-renders (see the
// three sibling files above for the same reasoning). Copied into the static
// export via export_static.py's _copy_assets()/shell <script> list —
// referenced, not duplicated, zero Dash-specific dependencies.
(function () {
  "use strict";

  function resizeVisible(container) {
    // Double-RAF: let a just-revealed display:none -> block flip settle
    // before Plotly reads the container's real box (same pattern as
    // showtime_toggle.js / export_static.py's showPage()).
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var graphs = container.querySelectorAll(".js-plotly-plot");
        graphs.forEach(function (gd) {
          try { Plotly.Plots.resize(gd); } catch (e) { /* not a plotly div yet, ignore */ }
        });
      });
    });
  }

  document.addEventListener("click", function (ev) {
    var target = ev.target;

    // ── 1. Sort-mode toggle ────────────────────────────────────────────────
    var sortBtn = target.closest ? target.closest(".tech-sort-btn") : null;
    if (sortBtn) {
      var mode = sortBtn.getAttribute("data-mode");
      var card = sortBtn.closest(".tech-carousel-panel") || sortBtn.closest(".plot-card");
      if (!card || !mode) return;

      // WP-93: a card with data-sort-group="X" moves in lockstep with every
      // other card sharing that group (same mechanism as carousel #2's
      // data-carousel-group below) — pairs the dumbbell/Likert genre-
      // country-decade toggle so both switch dimension together.
      var group = card.getAttribute("data-sort-group");
      var targets = group
        ? Array.prototype.slice.call(document.querySelectorAll('[data-sort-group="' + group + '"]'))
        : [card];

      targets.forEach(function (c) {
        c.querySelectorAll(".tech-sort-btn").forEach(function (b) {
          b.classList.toggle("active", b.getAttribute("data-mode") === mode);
        });
        var panel = null;
        c.querySelectorAll(".tech-sort-panel").forEach(function (p) {
          var show = p.classList.contains(mode);
          p.classList.toggle("active", show);
          if (show) panel = p;
        });
        if (panel) resizeVisible(panel);
      });
      return;
    }

    // ── 2. Carousel prev/next ──────────────────────────────────────────────
    var navBtn = target.closest
      ? (target.closest(".tech-carousel-prev") || target.closest(".tech-carousel-next"))
      : null;
    if (navBtn) {
      var carousel = navBtn.closest(".tech-carousel");
      if (!carousel) return;
      var dir = navBtn.classList.contains("tech-carousel-prev") ? -1 : 1;

      // WP-92 round 4: grouped carousels move together — same direction,
      // same step, applied to each member independently (each keeps its
      // own data-carousel-index, they just always take the same step).
      var group = carousel.getAttribute("data-carousel-group");
      var members = group
        ? Array.prototype.slice.call(
            document.querySelectorAll('.tech-carousel[data-carousel-group="' + group + '"]')
          )
        : [carousel];

      members.forEach(function (c) {
        var panels = c.querySelectorAll(".tech-carousel-panel");
        if (!panels.length) return;
        var current = parseInt(c.getAttribute("data-carousel-index"), 10) || 0;
        var next = (current + dir + panels.length) % panels.length;

        panels[current].classList.remove("active");
        panels[next].classList.add("active");
        c.setAttribute("data-carousel-index", String(next));

        resizeVisible(panels[next]);
      });
      return;
    }

    // ── 3. Bubble color toggle ─────────────────────────────────────────────
    var colorBtn = target.closest ? target.closest(".tech-color-toggle") : null;
    if (colorBtn) {
      var colorCard = colorBtn.closest(".tech-carousel-panel") || colorBtn.closest(".plot-card");
      if (!colorCard || !window.Plotly) return;
      var toDeviation = !colorBtn.classList.contains("active");
      colorBtn.classList.toggle("active", toDeviation);
      // WP-92 round 2: tooltip always names the CURRENT state + what a click
      // does next, rather than a static "toggles color" description.
      colorBtn.title = toDeviation
        ? "Showing: color by how much I deviate from the crowd (warm=more generous, cool=harsher than usual). Click for the plain rating-scale color instead."
        : "Showing: plain rating-scale color (green=5★, red=0.5★). Click to color by how much I deviate from the crowd instead.";

      colorCard.querySelectorAll(".js-plotly-plot").forEach(function (gd) {
        if (!gd.data) return;
        var colors = gd.data.map(function (trace) {
          if (!trace.meta) return trace.marker ? trace.marker.color : null;
          return toDeviation ? trace.meta.devColors : trace.meta.ratingColors;
        });
        Plotly.restyle(gd, { "marker.color": colors });
      });
      return;
    }
  });
})();
