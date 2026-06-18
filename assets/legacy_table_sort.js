// WP-80: Best Years / Best Decades tables (Stats page bottom row) —
// client-side column sort.
//
// Delegated, document-level listener (same reasoning as
// assets/showtime_toggle.js and assets/cinema_map_toggle.js — Dash tears
// down and rebuilds the whole card on every page navigation, so a listener
// bound directly to a <th> at render time would be lost the next time Dash
// re-renders it). Dash auto-serves every assets/*.js file; the static export
// copies this same file and references it via
// <script src="assets/legacy_table_sort.js"> (see export_static.py).
//
// Every row (including ones outside the default top-N view, marked
// className="ltrow-extra" and CSS-hidden — see assets/app.css) is already in
// the DOM, each carrying its sort payload as data-s-label/-count/-rating/
// -likes (numeric strings) plus data-s-idx (its position in the
// already-rating-sorted default order). Sorting never re-fetches or
// re-renders from Dash — it only reorders existing <tr> elements and toggles
// their inline display, so pins (current-year green / most-liked orange)
// stay attached to whichever row they belong to no matter where a sort
// lands it.
//
// No persistence: navigating away from the page / any Dash re-render of the
// card always restores the default (pinned) view — intentional (see the
// WP-80 plan), not a limitation to fix later.
(function () {
  "use strict";

  function allRows(card) {
    return Array.prototype.slice.call(card.querySelectorAll("tbody tr[data-s-idx]"));
  }

  function defaultCount(rows) {
    // Rows outside the original default view all carry className
    // "ltrow-extra" (set once, server-side, by _legacy_ranking_card's
    // in_default flag — never mutated here); counting the rows WITHOUT it
    // reproduces the same N used to build the default view (Best Years/
    // Decades' own best_years_decades_top_n config, independent of the
    // "Top N in release year" panels' year_in_review_top_n) without this
    // file needing to know that number itself.
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].classList.contains("ltrow-extra")) n++;
    }
    return n;
  }

  function clearSortMarks(card) {
    var ths = card.querySelectorAll("th[data-sort-key]");
    ths.forEach(function (th) {
      th.classList.remove("sort-active");
      var mark = th.querySelector(".sort-arrow");
      if (mark) mark.parentNode.removeChild(mark);
    });
  }

  function restoreDefault(card) {
    var tbody = card.querySelector("tbody");
    if (!tbody) return;
    var rows = allRows(card);
    rows.sort(function (a, b) {
      return Number(a.dataset.sIdx) - Number(b.dataset.sIdx);
    });
    rows.forEach(function (tr) {
      tr.style.display = "";
      tbody.appendChild(tr);
    });
    clearSortMarks(card);
    delete card.dataset.activeSort;
  }

  function applySort(card, key) {
    var tbody = card.querySelector("tbody");
    if (!tbody) return;
    var rows = allRows(card);
    var n = defaultCount(rows);   // re-sorted view shows the same row COUNT as default, just re-ranked
    var attr = "s" + key.charAt(0).toUpperCase() + key.slice(1);   // "rating" -> "sRating"

    rows.sort(function (a, b) {
      return Number(b.dataset[attr]) - Number(a.dataset[attr]);
    });
    rows.forEach(function (tr, i) {
      // BUGFIX: must be a real value ("table-row"/"none"), never "" — rows
      // outside the original default view still carry className
      // "ltrow-extra" (CSS display:none), and an empty inline style defers
      // to that class rule instead of overriding it. With "" here, a row
      // that newly ranks inside the top N after this sort stayed hidden
      // anyway (its class was never touched), while the only rows that
      // could ever show were the ones that never had the class to begin
      // with — i.e. just the pinned rows, regardless of where the sort put
      // them. An explicit value beats the class every time, so any row can
      // now move in or out of view based on where THIS sort ranks it.
      tr.style.display = i < n ? "table-row" : "none";
      tbody.appendChild(tr);
    });

    clearSortMarks(card);
    var th = card.querySelector('th[data-sort-key="' + key + '"]');
    if (th) {
      th.classList.add("sort-active");
      var mark = document.createElement("span");
      mark.className = "sort-arrow";
      mark.textContent = " ▼";
      th.appendChild(mark);
    }
    card.dataset.activeSort = key;
  }

  document.addEventListener("click", function (ev) {
    var target = ev.target;
    if (!target || !target.closest) return;

    var titleEl = target.closest(".legacy-rank-title");
    if (titleEl) {
      var titleCard = titleEl.closest(".legacy-rank-card");
      if (titleCard) restoreDefault(titleCard);
      return;
    }

    var th = target.closest("th[data-sort-key]");
    if (!th) return;
    var card = th.closest(".legacy-rank-card");
    if (!card) return;

    var key = th.dataset.sortKey;
    if (card.dataset.activeSort === key) {
      restoreDefault(card);
    } else {
      applySort(card, key);
    }
  });
})();
