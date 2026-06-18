// WP-115: "Last <-> Max year" toggle — client-side only, no Dash callback.
//
// Markup contract (see src/ui/components/year_mode.py):
//   .year-mode-card[data-year-mode-key][data-year-mode="last"|"max"]
//       [data-year-mode-locked="true"]
//     .year-mode-toggle > .year-mode-btn[data-year-mode-btn="last"|"max"]   (lead card only)
//     .year-mode-panel[data-year-modes="last" | "max" | "last max"]
// Cards sharing a data-year-mode-key (a lead + its follower) switch together.
// CSS (assets/app.css) shows only the panels whose data-year-modes contains the
// card's current data-year-mode; every variant ships fully drawn in the DOM, so
// the swap is just an attribute flip + a Plotly resize of the revealed graphs
// (a chart drawn under display:none sized itself against a zero-width box —
// same reason as showtime_toggle.js / tech_panel_toggle.js).
//
// Persistence: one localStorage entry per panel key, "savo-year-mode:<key>"
// = "last" | "max". Every storage access is try/catch'd — the page must work
// with storage blocked (private window, file:// quirks) and just not remember.
//
// Re-render hook: the live Dash app tears a page's cards down and rebuilds them
// on every navigation (new nodes, always server-default "last"), so a click
// listener alone is not enough. A MutationObserver applies the saved mode to
// every card it has not seen yet, synchronously inside the mutation callback
// (a microtask, before the next paint — no flash of the wrong variant). The
// static export has all cards in the DOM at load; the same scan covers it.
//
// A locked card (Last year == Max year, or no earlier year) never changes
// mode and ignores clicks; a saved "max" is also ignored when the card has no
// Max panel. Copied into the static export (export_static.py _copy_assets()
// and the shell <script> list) — referenced, not duplicated, zero Dash
// dependencies.
(function () {
  "use strict";

  var STORE_PREFIX = "savo-year-mode:";
  var APPLIED_ATTR = "data-year-mode-applied";

  function readStored(key) {
    try { return window.localStorage.getItem(STORE_PREFIX + key); } catch (e) { return null; }
  }

  function writeStored(key, mode) {
    try { window.localStorage.setItem(STORE_PREFIX + key, mode); } catch (e) { /* storage blocked: not remembered */ }
  }

  function isLocked(card) {
    return card.getAttribute("data-year-mode-locked") === "true";
  }

  function hasPanelFor(card, mode) {
    var panels = card.querySelectorAll(".year-mode-panel");
    for (var i = 0; i < panels.length; i++) {
      var modes = (panels[i].getAttribute("data-year-modes") || "").split(/\s+/);
      if (modes.indexOf(mode) !== -1) return true;
    }
    return false;
  }

  // Flip ONE card to `mode` (false when it cannot: locked / no such panel).
  function applyToCard(card, mode) {
    if (isLocked(card) || !hasPanelFor(card, mode)) return false;
    card.setAttribute("data-year-mode", mode);
    var btns = card.querySelectorAll(".year-mode-btn");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute("data-year-mode-btn") === mode;
      btns[i].classList.toggle("active", on);
      btns[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    return true;
  }

  // Resize the graphs of the panels now visible in `card`. Double-RAF lets the
  // display flip settle first. Hidden containers (a card on another static
  // page) are skipped — the shell's showPage() resizes them when revealed.
  function resizeVisible(card) {
    if (!window.Plotly) return;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var graphs = card.querySelectorAll(".year-mode-panel .js-plotly-plot");
        for (var i = 0; i < graphs.length; i++) {
          var gd = graphs[i];
          if (!gd.offsetWidth) continue;   // display:none ancestor
          try {
            var p = Plotly.Plots.resize(gd);
            if (p && p.catch) p.catch(function () { /* not displayed yet, ignore */ });
          } catch (e) { /* not a plotly div yet, ignore */ }
        }
      });
    });
  }

  function cardsWithKey(key) {
    var all = document.querySelectorAll(".year-mode-card");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute("data-year-mode-key") === key) out.push(all[i]);
    }
    return out;
  }

  // Click: switch every card of this key, remember the choice.
  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest(".year-mode-btn") : null;
    if (!btn) return;
    var card = btn.closest(".year-mode-card");
    if (!card || isLocked(card)) return;
    var mode = btn.getAttribute("data-year-mode-btn");
    var key = card.getAttribute("data-year-mode-key");
    if (!mode || !key) return;

    var changed = false;
    cardsWithKey(key).forEach(function (c) {
      if (applyToCard(c, mode)) { changed = true; resizeVisible(c); }
    });
    if (changed) writeStored(key, mode);
  });

  // Apply the saved mode to cards not seen before (initial load, Dash re-render).
  function scan() {
    var fresh = document.querySelectorAll(".year-mode-card:not([" + APPLIED_ATTR + "])");
    for (var i = 0; i < fresh.length; i++) {
      var card = fresh[i];
      card.setAttribute(APPLIED_ATTR, "1");
      var stored = readStored(card.getAttribute("data-year-mode-key") || "");
      if (stored === "max" && applyToCard(card, "max")) resizeVisible(card);
    }
  }

  // Cheap pre-filter: Plotly adds thousands of SVG nodes on every draw/resize;
  // only a record that actually added a card (or a subtree containing one)
  // is worth a document scan.
  function addedACard(records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains("year-mode-card")) return true;
        if (n.querySelector && n.querySelector(".year-mode-card")) return true;
      }
    }
    return false;
  }

  function init() {
    scan();
    if (window.MutationObserver && document.body) {
      new MutationObserver(function (records) {
        if (addedACard(records)) scan();
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
