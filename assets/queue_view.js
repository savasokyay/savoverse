// WP-106: Queue page (⏳) — view switch, preset/signal score recompute,
// two-state column sort, load-more windowing, top-strip list filter, and
// lazy poster loading. Zero server round-trip for any of these — the same
// no-callback philosophy as assets/tech_panel_toggle.js / showtime_toggle.js
// / legacy_table_sort.js (Dash tears down and rebuilds #queue-card on every
// page navigation, so a listener bound directly to an element at render
// time would be lost the next time Dash re-renders it — a single delegated,
// document-level listener survives that).
//
// Score model: every row (in BOTH the Table <tr class="qrow"> and Cards
// <div class="queue-card"> views — they are two SEPARATE DOM trees built
// from the same candidates, so every operation below runs once per view)
// carries its 8 normalised (0-1) signals as data-q-sig-<name> attributes.
// #queue-card itself carries data-q-presets, a JSON object of
// {presetId: {signal: weight, ...}} straight from config.queue.presets —
// Python and this file read the SAME numbers, so recomputing a score here
// can never drift from src/engine/queue_index.py::score_candidate()'s
// formula (Σ weight_i * signal_i) as long as both stay in sync by hand.
//
// Persistence: chosen preset/custom-signal-state/active view are written to
// localStorage (key prefix "savo-queue-", matching the static shell's own
// "savo-active-page" naming) and re-applied every time #queue-card appears.
//
// Init timing — the ONE thing this file needs beyond the delegated-click
// idiom shared with tech_panel_toggle.js/legacy_table_sort.js: those files
// only ever REACT to a click, so it never matters exactly when Dash injects
// their markup — a document-level listener already covers it. This file
// also needs to APPLY the initial (restored or server-default) score sort
// and 100-row window the moment #queue-card first exists, and #queue-card
// is a React node Dash renders asynchronously (it does not exist yet when
// this deferred script itself runs, unless Queue happens to already be the
// mounted page). A MutationObserver on document.body is the standard fix
// for "run this once new content shows up" without polling; it also means
// navigating away from Queue and back re-applies the SAME restored state
// (an upgrade over legacy_table_sort.js's own "no persistence across a
// Dash re-render, intentional" contract for the closest analogous
// feature — that one only had to reset a hard-coded default on nav, this
// one has real cross-visit state worth keeping). In the STATIC export
// #queue-card is built once and never removed (only its .spage ancestor
// toggles display via showPage()), so the observer fires once, harmlessly.
(function () {
  "use strict";

  var SIGNALS = [
    ["lists", "lists"], ["oscar-win", "oscar_win"], ["oscar-nom", "oscar_nom"],
    ["closer", "closer"], ["completion", "completion"], ["finisher", "finisher"],
    ["rank", "rank"], ["rating", "rating"],
  ]; // [data-attr suffix (hyphenated), config.json / preset JSON key (underscored)]

  // ── Small helpers ──────────────────────────────────────────────────────

  function card() { return document.getElementById("queue-card"); }

  function readPresets(c) {
    try { return JSON.parse(c.getAttribute("data-q-presets") || "{}"); }
    catch (e) { return {}; }
  }

  function readCustomSignals(c) {
    try { return JSON.parse(c.dataset.qCustomSignals || "{}"); }
    catch (e) { return {}; }
  }

  function readCustomWeights(c) {
    try { return JSON.parse(c.dataset.qCustomWeights || "{}"); }
    catch (e) { return {}; }
  }

  function seedCustomWeights(c) {
    // WP-106 round 4: same first-entry seeding gap as seedCustomSignals()
    // below, but for the per-signal weight VALUE instead of its on/off
    // state — seed every missing key from data-q-presets's own "custom"
    // entry (config.queue.presets.custom, the same numbers the server used
    // to render each .queue-weight-val's initial text) so the +/- steppers
    // never adjust an undefined weight into NaN.
    var weights = readCustomWeights(c);
    var base = readPresets(c).custom || {};
    var changed = false;
    SIGNALS.forEach(function (pair) {
      var jsonKey = pair[1];
      if (!(jsonKey in weights)) { weights[jsonKey] = base[jsonKey] || 0; changed = true; }
    });
    if (changed) c.dataset.qCustomWeights = JSON.stringify(weights);
    return weights;
  }

  function seedCustomSignals(c) {
    // BUG FOUND live-testing this WP: qCustomSignals starts life as "{}" (no
    // signal has been individually toggled yet) the FIRST time a session
    // enters Custom mode — activeWeights() below then read every signal's
    // ABSENCE from that empty object as "off", zeroing every weight and
    // every score, even though the server-rendered buttons already show
    // several signals as visibly active (seeded from the custom preset's
    // own nonzero weights, see mod_queue.py._render_controls). Fix: fully
    // seed all 8 keys from the buttons' rendered .active state THE MOMENT
    // Custom is entered (if the dict doesn't already have every key — e.g.
    // a restored localStorage value keeps whatever the user last set), so
    // activeWeights() never has to guess or special-case a missing key.
    var custom = readCustomSignals(c);
    var changed = false;
    SIGNALS.forEach(function (pair) {
      var jsonKey = pair[1];
      if (!(jsonKey in custom)) {
        var btn = document.querySelector('.queue-signal-btn[data-q-signal="' + jsonKey + '"]');
        custom[jsonKey] = !!(btn && btn.classList.contains("active"));
        changed = true;
      }
    });
    if (changed) c.dataset.qCustomSignals = JSON.stringify(custom);
    return custom;
  }

  function activeWeights(c) {
    var presets = readPresets(c);
    var preset = c.dataset.qActivePreset || c.dataset.qDefaultPreset || "balanced";
    var weights = presets[preset] || {};
    if (preset === "custom") {
      var on = seedCustomSignals(c);
      var customW = seedCustomWeights(c);   // WP-106 round 4: user-adjustable magnitude, not just on/off
      var out = {};
      SIGNALS.forEach(function (pair) {
        var jsonKey = pair[1];
        out[jsonKey] = on[jsonKey] ? (customW[jsonKey] || 0) : 0;
      });
      return out;
    }
    return weights;
  }

  function containers() {
    var out = [];
    var tbody = document.querySelector("#queue-card .q-rank-body");
    if (tbody) out.push({ root: tbody, sel: ".qrow", view: "table" });
    var grid = document.querySelector("#queue-card .queue-cards-grid");
    if (grid) out.push({ root: grid, sel: ".queue-card", view: "cards" });
    return out;
  }

  function rowsOf(container) {
    return Array.prototype.slice.call(container.root.querySelectorAll(container.sel));
  }

  // ── Score recompute ───────────────────────────────────────────────────

  function toCamel(suffix) {
    // "oscar-win" -> "OscarWin" (mirrors the browser's own data-* -> dataset
    // camelCasing exactly, including the FIRST letter — a plain .replace on
    // internal hyphens alone misses that first letter and silently reads
    // the wrong dataset key, e.g. "qSiglists" instead of "qSigLists").
    return suffix.charAt(0).toUpperCase()
      + suffix.slice(1).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  function recomputeScore(row, weights) {
    var total = 0;
    SIGNALS.forEach(function (pair) {
      var attr = "qSig" + toCamel(pair[0]);
      var v = parseFloat(row.dataset[attr]) || 0;
      var w = weights[pair[1]] || 0;
      total += v * w;
    });
    row.dataset.qSortScore = total.toFixed(6);
    // WP-106 round 4: Cards' score moved onto a plain-number corner badge
    // (queue-card-score-badge, no "SQS " text prefix — see mod_queue.py),
    // same bare-number format the Table view's own score cell already used,
    // so both views' .q-score-val now render identically here.
    var el = row.querySelector(".q-score-val");
    if (el) el.textContent = (total * 100).toFixed(1);
    return total;
  }

  function adjustWeight(c, sig, delta) {
    // WP-106 round 5: no upper cap — the user explicitly does not want a
    // "must sum to 1" rule enforced here; a weight is a plain multiplier in
    // a weighted sum (score_candidate() in queue_index.py), not a fraction
    // of a fixed pool, so an integer or anything > 1 is legitimate.
    var weights = seedCustomWeights(c);
    var next = Math.max(0, Math.round(((weights[sig] || 0) + delta) * 100) / 100);
    weights[sig] = next;
    c.dataset.qCustomWeights = JSON.stringify(weights);
    var val = document.querySelector('#queue-card .queue-weight-val[data-q-weight-val="' + sig + '"]');
    if (val) val.textContent = next.toFixed(2);
    refreshScored(c);
    saveState(c);
  }

  function recomputeAll(c) {
    var weights = activeWeights(c);
    containers().forEach(function (cont) {
      rowsOf(cont).forEach(function (row) { recomputeScore(row, weights); });
    });
  }

  // ── Sort + visibility ──────────────────────────────────────────────────
  // Two-state, same idiom as assets/legacy_table_sort.js, for every column
  // EXCEPT "Oscar" (data-q-sort-cycle — WP-108): first click on a column
  // sorts desc by it; a second click (or a preset/signal change, or
  // clicking the card's own title bar — there isn't one here, so only the
  // "click same header again" path applies) restores score order. The
  // Oscar column is 3-state instead (wins-first -> noms-first -> restore
  // to score order — see the th[data-q-sort-cycle] click handler below).

  function sortRows(container, specs) {
    // WP-108: specs is an array of {attr, numeric} dataset-key descriptors,
    // compared IN ORDER — each entry only breaks a tie left by the one
    // before it. A trailing {attr:"qSortScore"} tie-break is appended here
    // unconditionally, so every combination (including an empty/omitted
    // specs — the pre-WP-108 "restore score order" case) is still fully
    // deterministic without every caller having to remember to add it.
    var rows = rowsOf(container);
    var full = (specs || []).concat([{ attr: "qSortScore", numeric: true }]);
    rows.sort(function (a, b) {
      for (var i = 0; i < full.length; i++) {
        var spec = full[i];
        if (spec.numeric) {
          var av = parseFloat(a.dataset[spec.attr]) || 0;
          var bv = parseFloat(b.dataset[spec.attr]) || 0;
          if (av !== bv) return bv - av;   // desc
        } else {
          var as = a.dataset[spec.attr] || "", bs = b.dataset[spec.attr] || "";
          if (as !== bs) return as < bs ? 1 : -1;   // desc, matches score/numeric direction
        }
      }
      return 0;
    });
    rows.forEach(function (r) { container.root.appendChild(r); });
  }

  function applySort(c, key, specs, headerEl, markText) {
    // key: falsy => restore score order (specs/headerEl/markText ignored).
    // Otherwise a state id used ONLY for the NEXT click's equality check
    // against c.dataset.qActiveSort — a plain column's own
    // data-q-sort-key value, or "oscar-w"/"oscar-n" for the Oscar cycle
    // (WP-108). specs: array of {attr, numeric} passed to sortRows().
    // headerEl: the <th> to mark active, passed by the caller (it already
    // has the clicked element from the event) rather than re-queried here
    // — data-q-sort-cycle's value is a comma LIST, so it can't be looked
    // up by a single state id the way data-q-sort-key's single value could.
    c.dataset.qActiveSort = key || "";
    containers().forEach(function (cont) { sortRows(cont, specs); });
    resetWindow(c);
    applyVisibility(c);
    clearSortMarks(c);
    if (key && headerEl) {
      headerEl.classList.add("q-sort-active");
      var mark = document.createElement("span");
      mark.className = "sort-arrow";
      mark.textContent = " " + (markText || "▼");
      headerEl.appendChild(mark);
    }
  }

  function clearSortMarks(c) {
    // WP-108: also clears the Oscar column's own cycle header — it carries
    // data-q-sort-cycle, not data-q-sort-key, so it needs its own selector
    // term here or its "▼W"/"▼N" mark would never get removed on the next
    // sort change.
    document.querySelectorAll("#queue-card th[data-q-sort-key], #queue-card th[data-q-sort-cycle]").forEach(function (th) {
      th.classList.remove("q-sort-active");
      var mark = th.querySelector(".sort-arrow");
      if (mark) mark.parentNode.removeChild(mark);
    });
  }

  // ── Panel height: fit the ACTUAL remaining screen space ─────────────────
  // BUG FOUND from real usage (Table view, originally): a flat CSS
  // max-height (app.css's 70vh) is a guess — it ignores how tall the strip/
  // controls ABOVE the panel actually render (varies with how many "closest
  // to completion" lists qualify) and the real browser window height, so it
  // can leave a lot of unused space below the panel or cut it shorter than
  // the screen allows. Measured fix: read the wrap's own top offset + the
  // "Load more" button's real height (0 when it's hidden — self-adjusting)
  // and set max-height to exactly what's left down to the viewport's bottom
  // edge, with a small reserve for the button/footnote below it and page
  // bottom padding.
  // WP-106b round 7: factored out of a table-only fitTableHeight() so the
  // Cards view's own scroll wrap (.queue-cards-wrap, new) gets the identical
  // treatment — user asked for the strip/controls to stay fixed with only
  // the cards scrolling, same as Table already did; the mechanism (bound the
  // one big scrollable box so the page itself never needs to scroll) is
  // identical for both, only the selector differs.
  // WP-108: BUG FOUND from real usage (view-switch, e.g. Table -> Cards):
  // the panel could render far shorter than the real remaining screen space
  // — independent of the 70vh-vs-real-height problem round 6 already fixed
  // above. Root cause was TWO-fold: (1) fitPanelHeight only ever ran on
  // init/view-switch/window-resize, never when something ABOVE the panel
  // (the "All lists" strip's ~140 badges wrapping to many rows, Custom
  // mode's signal-toggle row, the cap-notice, "Load more") changed height —
  // a stale measurement from BEFORE that content grew/shrank stuck around
  // until the next of those three explicit triggers (a reload "fixed" it
  // purely because init() re-measures from scratch); (2) `window.innerHeight
  // - wrap top` silently assumed the PAGE ITSELF is the scroller, which is
  // false in both the live app (#main-content) and the static export
  // (.smain) — usually harmless when the wrap's top roughly tracks
  // window-relative position, but wrong the moment the real scroller is
  // itself scrolled (top keeps shrinking even though the AVAILABLE height
  // below the wrap, within that scroller, hasn't changed).
  function findScroller(el) {
    // Nearest ancestor that actually scrolls vertically — walking up by
    // computed overflow avoids hardcoding either #main-content (live) or
    // .smain (static); falls back to the document's own scroller if
    // neither wraps this page (e.g. an isolated test harness).
    var node = el.parentElement;
    while (node && node !== document.body) {
      var cs = window.getComputedStyle(node);
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function fitPanelHeight(wrap) {
    // Skip a wrap that isn't actually on screen right now (its own view not
    // active, or #queue-card not the current page) — offsetParent is null
    // for any display:none ancestor; a later ResizeObserver firing or the
    // explicit view-switch/strip-mode/preset call re-measures once it IS
    // visible, so nothing is lost by skipping here.
    if (!wrap || wrap.offsetParent === null) return;
    var moreBtn = wrap.parentElement ? wrap.parentElement.querySelector(".queue-more-btn") : null;
    var notice = document.getElementById("queue-cap-notice");
    var reserve = 16;   // page bottom padding, no reliable selector for that alone
    if (moreBtn) reserve += moreBtn.getBoundingClientRect().height + 10;   // 0 when hidden (display:none) — self-adjusting
    if (notice) reserve += notice.getBoundingClientRect().height + 6;      // WP-107's cap-notice — same self-adjusting logic

    var scroller = findScroller(wrap);
    var wrapRect = wrap.getBoundingClientRect();
    var scrollerRect = scroller.getBoundingClientRect();
    var top = wrapRect.top - scrollerRect.top + (scroller.scrollTop || 0);
    var available = scroller.clientHeight - top - reserve;
    wrap.style.maxHeight = Math.max(200, Math.round(available)) + "px";
  }
  function fitTableHeight(c) { fitPanelHeight(c.querySelector(".queue-table-wrap")); }
  function fitCardsHeight(c) { fitPanelHeight(c.querySelector(".queue-cards-wrap")); }

  // Single entry point for every "something that affects the panel's
  // available height might have changed" trigger (ResizeObserver, view
  // switch, an explicit call after a strip-mode/preset/visibility change,
  // window resize) — a burst of triggers within the same frame still
  // measures and writes style.maxHeight only once. Double-RAF (the SAME
  // idiom scripts/export_static.py's own _resizeVisible()/showPage() use,
  // there for Plotly chart resizing after a page/sidebar toggle, "let
  // browser complete CSS grid/flex layout before resize") rather than a
  // single rAF: CSS Grid's auto-fill column count (.queue-cards-grid) and
  // this panel's own flex/grid ancestors depend on their CONTAINER's final
  // settled width, which a single frame after a display:none -> block
  // toggle isn't reliably guaranteed to have yet — the likely reason a
  // plain page reload "fixed" the originally reported bug (a reload paints
  // directly into its already-settled final layout) while a live
  // Table<->Cards switch didn't.
  var _fitScheduled = false;
  function scheduleFit(c) {
    if (_fitScheduled) return;
    _fitScheduled = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        _fitScheduled = false;
        var target = c || document.getElementById("queue-card");   // avoid shadowing the top-level card() helper
        if (target) fitActivePanel(target);
      });
    });
  }

  // Watches the two things ABOVE the panel whose height can change WITHOUT
  // any of the explicit fit call sites below running: the "All lists" strip
  // growing/shrinking as its badges wrap to more or fewer rows when the
  // strip-mode toggles or the window narrows, and Custom mode's
  // signal-toggle row appearing/disappearing inside .queue-controls. Set up
  // once per #queue-card mount (init() disconnects any previous observer
  // first — Dash tears down and rebuilds this node on page navigation, see
  // this file's header comment).
  var _fitObserver = null;
  function setupFitObserver(c) {
    if (!("ResizeObserver" in window)) return;   // scheduleFit()'s explicit call sites below still cover the common cases
    if (_fitObserver) _fitObserver.disconnect();
    _fitObserver = new ResizeObserver(function () { scheduleFit(c); });
    var controls = c.querySelector(".queue-controls");
    var stripGroups = c.querySelector(".queue-strip-groups");
    if (controls) _fitObserver.observe(controls);
    if (stripGroups) _fitObserver.observe(stripGroups);
  }

  // WP-106b round 7: which panel is actually visible right now, read from
  // the DOM (.queue-panel.active) rather than c.dataset.qActiveView — that
  // dataset attribute stays UNSET for a first-ever visit (restoreState()
  // only writes it from a saved localStorage value; nothing seeds a
  // default), so it can't be trusted before the user has ever clicked a
  // view button this session. The rendered "active" class is always
  // present on exactly one panel (server-rendered default, or JS-toggled),
  // so this is correct at every point in the lifecycle.
  function activeViewName(c) {
    var panel = c.querySelector(".queue-panel.active");
    return (panel && panel.classList.contains("queue-panel-cards")) ? "cards" : "table";
  }

  function fitActivePanel(c) {
    if (activeViewName(c) === "cards") {
      fitCardsHeight(c);
    } else {
      fitTableHeight(c);
      nudgeStickyHeader(c);   // table-only — Cards has no sticky descendant to nudge
    }
  }

  // ── Sticky table header: force-reflow workaround ───────────────────────
  // BUG FOUND live-testing this WP: .queue-table thead th's position:sticky
  // is computed correctly (getComputedStyle shows position:sticky/top:0px)
  // but the header still scrolls away with the body rows on first render —
  // proven (A/B, DOM-measured, not just eyeballed) to be Chrome caching the
  // sticky containing-block computation from BEFORE .queue-table-wrap's
  // real overflow/height was settled (initial paint, still-mounting table),
  // and never revisiting it — applying the IDENTICAL position/top via
  // inline style, or merely toggling .overflow off and back on (touching
  // nothing sticky-related at all), both independently make it start
  // sticking correctly. So: nudge a reflow on the wrap once the table's
  // rows have actually settled (mount, and again on switching INTO the
  // table view, since going display:none -> block is the same "wasn't
  // settled yet at first layout" situation for that panel).
  function nudgeStickyHeader(c) {
    var wrap = c.querySelector(".queue-table-wrap");
    if (!wrap) return;
    var prev = wrap.style.overflow;
    wrap.style.overflow = "hidden";
    void wrap.offsetHeight;   // force synchronous layout before flipping back
    wrap.style.overflow = prev || "auto";
  }

  // ── Window (Load more) + strip filter ──────────────────────────────────

  function resetWindow(c) {
    c.dataset.qWindowCur = c.getAttribute("data-q-window") || "100";
  }

  // WP-107: a list's badge can now exist in BOTH strip groups ("Closest to
  // completion" and "All lists"), so "is this badge active" has to be
  // decided by matching data-q-strip-list against the current filter, not
  // by comparing DOM-node identity to whichever badge was physically
  // clicked (correct back when only one badge row existed at all — see the
  // stripBtn handler below, which used to do exactly that inline).
  function syncStripActive(c) {
    var filter = c.dataset.qListFilter || "";
    document.querySelectorAll("#queue-card .queue-strip-badge").forEach(function (b) {
      b.classList.toggle("active", !!filter && b.getAttribute("data-q-strip-list") === filter);
    });
  }

  function applyVisibility(c) {
    var filter = c.dataset.qListFilter || "";
    var windowSize = parseInt(c.dataset.qWindowCur, 10) || 100;
    var matchTotals = {};   // WP-107: view name -> true matching-row count (before windowing), so updateCapNotice can compare it against the clicked badge's data-q-strip-total without a second DOM pass
    containers().forEach(function (cont) {
      var shown = 0, matchingTotal = 0;
      rowsOf(cont).forEach(function (row) {
        var matches = !filter || (row.dataset.qLists || "").split(",").indexOf(filter) !== -1;
        if (!matches) {
          row.style.display = "none";
          return;
        }
        matchingTotal++;
        var visible = shown < windowSize;
        if (visible) shown++;
        row.style.display = visible ? "" : "none";
      });
      matchTotals[cont.view] = matchingTotal;
      var btn = cont.root.parentElement.querySelector(".queue-more-btn");
      if (btn) btn.style.display = matchingTotal > windowSize ? "" : "none";
    });
    c.__qMatchTotals = matchTotals;
    updateCapNotice(c, filter);
    // WP-108: a filter/window change can toggle "Load more" and/or the
    // cap-notice — both feed fitPanelHeight's reserve calculation, and
    // neither lives inside .queue-controls/.queue-strip-groups (the two
    // ResizeObserver targets), so they need this explicit trigger.
    scheduleFit(c);
  }

  // WP-107: tells apart a list that's genuinely fully shown from one that's
  // just cropped by this render's max_rows/cards_max_rows cap — BUG FOUND
  // testing the "All lists" feature on the real published export: several
  // badges (e.g. "Lbxd Top '20s · 109 left") silently showed only a handful
  // of films with no explanation, because most of that list's candidates
  // simply weren't among the top-scored rows this page capped itself to.
  // No client-side fix can conjure a row the server never rendered, so this
  // only ever surfaces the gap — see also the SEPARATE, actual-bug fix in
  // queue_index.py (candidate_eligible) for badges that showed nothing for
  // a completely different reason (excluded from the candidate pool
  // entirely, at ANY cap).
  function updateCapNotice(c, filter) {
    var notice = document.getElementById("queue-cap-notice");
    if (!notice) return;
    var totals = c.__qMatchTotals || {};
    var shown = totals[activeViewName(c)];
    if (!filter || shown === undefined) { notice.style.display = "none"; return; }
    var badge = document.querySelector('.queue-strip-badge[data-q-strip-list="' + filter + '"]');
    var total = badge ? parseInt(badge.getAttribute("data-q-strip-total"), 10) : NaN;
    if (total && shown < total) {
      notice.textContent = "Showing " + shown + " of " + total + " unwatched titles for this list — " +
        "the rest fell outside this page's row limit (config.queue.max_rows / cards_max_rows).";
      notice.style.display = "";
    } else {
      notice.style.display = "none";
      notice.textContent = "";   // WP-107: avoid a stale message lingering (harmless while hidden, but confusing to inspect)
    }
  }

  function setSignalsVisible(show) {
    // WP-106 round 4: the Custom-only separator dot (.queue-signals-sep)
    // must show/hide in lockstep with .queue-signals itself — 2 call sites
    // (init() restore, preset-button click) previously only touched the
    // signals row; factored out so a 3rd never forgets the separator.
    var disp = show ? "" : "none";
    var signalsRow = document.querySelector("#queue-card .queue-signals");
    if (signalsRow) signalsRow.style.display = disp;
    var sep = document.querySelector("#queue-card .queue-signals-sep");
    if (sep) sep.style.display = disp;
  }

  function growWindow(c) {
    var step = parseInt(c.getAttribute("data-q-step"), 10) || 100;
    c.dataset.qWindowCur = String((parseInt(c.dataset.qWindowCur, 10) || 100) + step);
    applyVisibility(c);
  }

  // ── Lazy poster loading (IntersectionObserver) ─────────────────────────
  // BUG FOUND live-testing this WP: registering .observe() on an image while
  // its ancestor panel is display:none (Cards not yet the active view) and
  // THEN flipping that ancestor to display:block later never re-fires the
  // callback for those already-registered targets in this environment — a
  // brand-new observer created AFTER the panel is visible fires instantly,
  // proving IntersectionObserver itself works fine here; it's specifically
  // "observe while hidden, reveal later" that silently never resolves. Fix:
  // only ever observe images inside the CURRENTLY VISIBLE panel (queried
  // fresh each call) — never blindly across the whole card — so an image is
  // always observe()'d at a moment its geometry is real, never while hidden.
  var _posterObserver = null;
  function observePosters(c) {
    // WP-106 round 2: attribute-based, not class-based — covers the Table
    // view's small row-thumbnail (.queue-table-poster) and the Cards view's
    // full poster (.queue-card-poster) with the one selector, no need to
    // keep two class names in sync here.
    var imgs = c.querySelectorAll(".queue-panel.active img[data-q-poster]");
    if (!("IntersectionObserver" in window)) {
      // No IO support: fall back to loading everything immediately.
      imgs.forEach(function (img) {
        var src = img.getAttribute("data-q-poster");
        if (src) img.src = src;
      });
      return;
    }
    if (!_posterObserver) {
      _posterObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var img = entry.target;
          var src = img.getAttribute("data-q-poster");
          if (src && !img.src) img.src = src;
          _posterObserver.unobserve(img);
        });
      }, { rootMargin: "200px" });
    }
    imgs.forEach(function (img) {
      if (!img.src) _posterObserver.observe(img);
    });
  }

  // ── localStorage persistence ────────────────────────────────────────────

  function saveState(c) {
    try {
      localStorage.setItem("savo-queue-preset", c.dataset.qActivePreset || "");
      localStorage.setItem("savo-queue-custom-signals", c.dataset.qCustomSignals || "{}");
      localStorage.setItem("savo-queue-custom-weights", c.dataset.qCustomWeights || "{}");
      localStorage.setItem("savo-queue-view", c.dataset.qActiveView || "");
    } catch (e) { /* ignore */ }
  }

  function restoreState(c) {
    try {
      var preset = localStorage.getItem("savo-queue-preset");
      if (preset) c.dataset.qActivePreset = preset;
      var custom = localStorage.getItem("savo-queue-custom-signals");
      if (custom) c.dataset.qCustomSignals = custom;
      var weights = localStorage.getItem("savo-queue-custom-weights");
      if (weights) c.dataset.qCustomWeights = weights;
      var view = localStorage.getItem("savo-queue-view");
      if (view) c.dataset.qActiveView = view;
    } catch (e) { /* ignore */ }
  }

  // ── Master refresh: recompute -> sort by score -> reset window -> visibility ──

  function refreshScored(c) {
    recomputeAll(c);
    applySort(c, null, null);
  }

  // ── Init: apply restored (or server-default) state to whatever exists ──

  function init() {
    var c = card();
    if (!c) return;
    restoreState(c);

    var preset = c.dataset.qActivePreset || c.dataset.qDefaultPreset || "balanced";
    document.querySelectorAll("#queue-card .queue-preset-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-q-preset") === preset);
    });
    setSignalsVisible(preset === "custom");
    if (preset === "custom") {
      var custom = readCustomSignals(c);
      document.querySelectorAll("#queue-card .queue-signal-btn").forEach(function (b) {
        var sig = b.getAttribute("data-q-signal");
        if (Object.prototype.hasOwnProperty.call(custom, sig)) {
          b.classList.toggle("active", !!custom[sig]);
        }
      });
      var customW = seedCustomWeights(c);
      document.querySelectorAll("#queue-card .queue-weight-val").forEach(function (el) {
        var sig = el.getAttribute("data-q-weight-val");
        if (Object.prototype.hasOwnProperty.call(customW, sig)) {
          el.textContent = Number(customW[sig]).toFixed(2);
        }
      });
    }

    var view = c.dataset.qActiveView;
    if (view) {
      document.querySelectorAll("#queue-card .queue-view-btn").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-q-view") === view);
      });
      document.querySelectorAll("#queue-card .queue-panel").forEach(function (p) {
        var match = p.classList.contains("queue-panel-" + view);
        p.classList.toggle("active", match);
        p.style.display = match ? "" : "none";
      });
    }

    resetWindow(c);
    refreshScored(c);
    observePosters(c);
    setupFitObserver(c);   // WP-108: keep re-fitting whenever content ABOVE the panel changes height
    // WP-106b round 7 / WP-108: whichever view actually renders active, not
    // table-only. Routed through scheduleFit() (was an immediate call) —
    // covers a fresh load that restores directly into Cards (localStorage)
    // with the same double-RAF settling as a live view-switch now gets.
    scheduleFit(c);
  }

  // ── Delegated click handler ──────────────────────────────────────────────

  document.addEventListener("click", function (ev) {
    var target = ev.target;
    if (!target || !target.closest) return;
    var c = card();
    if (!c) return;

    var viewBtn = target.closest(".queue-view-btn");
    if (viewBtn && c.contains(viewBtn)) {
      var view = viewBtn.getAttribute("data-q-view");
      c.dataset.qActiveView = view;
      document.querySelectorAll("#queue-card .queue-view-btn").forEach(function (b) {
        b.classList.toggle("active", b === viewBtn);
      });
      document.querySelectorAll("#queue-card .queue-panel").forEach(function (p) {
        var match = p.classList.contains("queue-panel-" + view);
        p.classList.toggle("active", match);
        p.style.display = match ? "" : "none";
      });
      observePosters(c);
      // WP-107: Table and Cards can have different row caps, so a filter's
      // cap-notice (if any) can be right for one view and wrong for the
      // other — re-evaluate against whichever view is now active. Reads the
      // totals applyVisibility() already stashed; no need to recompute them.
      // WP-108: moved BEFORE the fit call below (was after) — the notice's
      // own height now feeds fitPanelHeight's reserve calculation, so
      // measuring first would use its PRE-switch visibility/height.
      updateCapNotice(c, c.dataset.qListFilter || "");
      // WP-106b round 7: Cards now gets the same fit-to-screen treatment on
      // switching into it that Table already had (no sticky header to nudge
      // there — see fitActivePanel's own comment). WP-108: routed through
      // scheduleFit() (was an immediate fitCardsHeight/fitTableHeight +
      // nudgeStickyHeader call) — see scheduleFit's own comment for why a
      // single synchronous measurement right after the display toggle
      // could read a not-yet-settled CSS Grid width.
      scheduleFit(c);
      saveState(c);
      return;
    }

    var presetBtn = target.closest(".queue-preset-btn");
    if (presetBtn && c.contains(presetBtn)) {
      var preset = presetBtn.getAttribute("data-q-preset");
      c.dataset.qActivePreset = preset;
      document.querySelectorAll("#queue-card .queue-preset-btn").forEach(function (b) {
        b.classList.toggle("active", b === presetBtn);
      });
      setSignalsVisible(preset === "custom");
      refreshScored(c);
      // WP-108: entering/leaving Custom mode shows/hides the signal-toggle
      // row inside .queue-controls, which the ResizeObserver already
      // watches — this explicit call is a fast-path/no-ResizeObserver
      // fallback, not the only trigger.
      scheduleFit(c);
      saveState(c);
      return;
    }

    var sigBtn = target.closest(".queue-signal-btn");
    if (sigBtn && c.contains(sigBtn)) {
      var sig = sigBtn.getAttribute("data-q-signal");
      // seedCustomSignals() already ran (via the preset click that revealed
      // this row, or the mount-time restore) by the time this row is even
      // visible/clickable, so `sig` is always already a key here — no
      // separate "first toggle" inference needed on top of that seeding.
      var custom = seedCustomSignals(c);
      custom[sig] = !custom[sig];
      c.dataset.qCustomSignals = JSON.stringify(custom);
      sigBtn.classList.toggle("active", custom[sig]);
      refreshScored(c);
      saveState(c);
      return;
    }

    var decBtn = target.closest("[data-q-weight-dec]");
    if (decBtn && c.contains(decBtn)) {
      adjustWeight(c, decBtn.getAttribute("data-q-weight-dec"), -0.02);
      return;
    }
    var incBtn = target.closest("[data-q-weight-inc]");
    if (incBtn && c.contains(incBtn)) {
      adjustWeight(c, incBtn.getAttribute("data-q-weight-inc"), 0.02);
      return;
    }

    var th = target.closest("th[data-q-sort-key]");
    if (th && c.contains(th)) {
      var key = th.getAttribute("data-q-sort-key");
      var type = th.getAttribute("data-q-sort-type") || "num";
      if (c.dataset.qActiveSort === key) {
        applySort(c, null, null);   // second click -> restore score order
      } else {
        var attr = "qSort" + key.charAt(0).toUpperCase() + key.slice(1);
        applySort(c, key, [{ attr: attr, numeric: type !== "text" }], th);
      }
      return;
    }

    // WP-108: "Oscar" column — 3-state cycle instead of the 2-state toggle
    // above: click 1 = wins-first (ties broken by nominations, then score),
    // click 2 = noms-first (ties by wins, then score), click 3 = restore
    // score order. A prior sort state that ISN'T this column's own two
    // states (a different column's key, or score order) is treated the
    // same as "start the cycle over" — clicking here always begins at
    // wins-first, regardless of what was active before.
    var cycleTh = target.closest("th[data-q-sort-cycle]");
    if (cycleTh && c.contains(cycleTh)) {
      var suffixes = cycleTh.getAttribute("data-q-sort-cycle").split(",");   // ["oscar-w", "oscar-n"]
      var winsSpec = { attr: "qSort" + toCamel(suffixes[0]), numeric: true };
      var nomsSpec = { attr: "qSort" + toCamel(suffixes[1]), numeric: true };
      var cycleCur = c.dataset.qActiveSort;
      if (cycleCur === "oscar-w") {
        applySort(c, "oscar-n", [nomsSpec, winsSpec], cycleTh, "▼N");
      } else if (cycleCur === "oscar-n") {
        applySort(c, null, null);   // third click -> restore score order
      } else {
        applySort(c, "oscar-w", [winsSpec, nomsSpec], cycleTh, "▼W");
      }
      return;
    }

    var moreBtn = target.closest(".queue-more-btn");
    if (moreBtn && c.contains(moreBtn)) {
      growWindow(c);
      observePosters(c);
      return;
    }

    var stripBtn = target.closest(".queue-strip-badge");
    if (stripBtn && c.contains(stripBtn)) {
      var fname = stripBtn.getAttribute("data-q-strip-list");
      var already = c.dataset.qListFilter === fname;
      c.dataset.qListFilter = already ? "" : fname;
      syncStripActive(c);
      resetWindow(c);
      applyVisibility(c);
      ev.preventDefault();   // it's an <a href> to the list page — filter click, don't navigate
      return;
    }

    // WP-107: "Closest to completion" / "All lists" — swaps which badge
    // GROUP is visible; the filter mechanic itself (above) is untouched and
    // already works against either group, since every badge in both already
    // carries the same data-q-strip-list attribute.
    var stripModeBtn = target.closest(".queue-strip-mode-btn");
    if (stripModeBtn && c.contains(stripModeBtn)) {
      var mode = stripModeBtn.getAttribute("data-q-strip-mode");
      document.querySelectorAll("#queue-card .queue-strip-mode-btn").forEach(function (b) {
        b.classList.toggle("active", b === stripModeBtn);
      });
      document.querySelectorAll("#queue-card .queue-strip-group").forEach(function (g) {
        g.classList.toggle("active", g.getAttribute("data-q-strip-group") === mode);
      });
      // WP-108: switching TO "All lists" (~140 badges, many wrap rows) or
      // back to "Closest to completion" (~12) changes .queue-strip-groups'
      // own height — the ResizeObserver already watches that wrapper, so
      // this explicit call is a fast-path/no-ResizeObserver fallback, not
      // the only trigger (this exact scenario was the original bug report).
      scheduleFit(c);
      return;
    }
    // Anything else (a film link, a visible list pill's own <a>) — let it navigate normally.
  });

  // ── Mount detection (see header comment for why this file needs it) ────

  var _lastCardSeen = null;
  function tryInit() {
    var c = card();
    if (c && c !== _lastCardSeen) {
      _lastCardSeen = c;
      init();
    }
  }
  if ("MutationObserver" in window) {
    new MutationObserver(tryInit).observe(document.body, { childList: true, subtree: true });
  }
  tryInit();   // covers the static export (#queue-card already present at parse time)

  // Re-fit the active panel's height whenever the window itself is resized
  // (the 70vh CSS fallback in app.css never adapts to a resize either) —
  // WP-108: routed through the SAME scheduleFit() coalescer every other
  // fit trigger now uses (was its own separate _resizeRAF throttle) so a
  // resize burst and, say, a ResizeObserver firing in the same frame don't
  // duplicate work. WP-106b round 7: covers Cards too (previously
  // table-only, and gated on a dataset flag that stays unset for a
  // first-ever visit — see activeViewName()'s own comment for why this
  // reads the DOM instead).
  window.addEventListener("resize", function () { scheduleFit(); });
})();
