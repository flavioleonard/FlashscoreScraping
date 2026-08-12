// HTML fixtures that mimic the real Flashscore DOM structure closely enough
// to exercise our scraping/dismissal logic without ever touching the real
// site: no network dependency, no flakiness from the live site changing
// again, and no risk of the scraper's IP getting rate-limited by tests.
// Selectors here are kept in sync by hand with the real ones in
// src/scraper/services/schedule/index.js and src/scraper/index.js.

// Builds a schedule-like page: a day-picker "next" button plus a match list
// that advances through `days` (an array of day snapshots, each an array of
// `{ country, competition, matches: [{ id, time }] }` groups) on each click —
// the real Flashscore day-picker is a client-side content swap, not a page
// navigation, so the fixture reproduces that with plain DOM manipulation
// instead of relying on page.goto.
//
// `blockerType` optionally renders one of our known overlay types (or an
// "unknown" one none of our dismiss functions recognize) covering the whole
// viewport from page load, exactly like the real age/cookie/locale dialogs
// do — each has its own close action wired up except "unknown", which is
// permanently stuck (used to test the exhausted-retries path).
export function buildSchedulePageHtml({ days, blockerType = "none" }) {
  return `<!doctype html>
<html><body>
<div class="sportName soccer" id="root"></div>
<button data-day-picker-arrow="next" id="next-day-btn"></button>
<script>
  const days = ${JSON.stringify(days)};
  let dayIndex = 0;

  function render() {
    const root = document.getElementById("root");
    root.innerHTML = "";
    days[dayIndex].forEach((group) => {
      const header = document.createElement("div");
      header.className = "headerLeague__wrapper";
      const flag = document.createElement("span");
      flag.className = "headerLeague__flag";
      flag.title = group.country;
      const title = document.createElement("span");
      title.className = "headerLeague__title-text";
      title.textContent = group.competition;
      header.appendChild(flag);
      header.appendChild(title);
      root.appendChild(header);

      group.matches.forEach((m) => {
        const row = document.createElement("div");
        row.id = "g_1_" + m.id;
        row.className = "event__match event__match--withRowLink event__match--twoLine";
        const link = document.createElement("a");
        link.className = "eventRowLink";
        link.href = "https://www.flashscore.com/match/football/" + m.id + "/?mid=" + m.id;
        const time = document.createElement("div");
        time.className = "event__time";
        time.textContent = m.time;
        row.appendChild(link);
        row.appendChild(time);
        root.appendChild(row);
      });
    });
  }

  function closeOverlay() {
    const el = document.querySelector(".blocking-overlay");
    if (el) el.remove();
  }

  function injectOverlay(type) {
    const overlay = document.createElement("div");
    overlay.classList.add("blocking-overlay");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "9999";
    overlay.style.background = "rgba(0,0,0,0.4)";

    if (type === "age") {
      overlay.setAttribute("data-testid", "wcl-dialog-overlay");
      overlay.setAttribute("data-state", "open");
      const btnOld = document.createElement("button");
      btnOld.setAttribute("data-testid", "wcl-button");
      btnOld.textContent = "I'M 18 AND OLDER";
      btnOld.addEventListener("click", closeOverlay);
      const btnYoung = document.createElement("button");
      btnYoung.setAttribute("data-testid", "wcl-button");
      btnYoung.textContent = "I'M YOUNGER THAN 18";
      overlay.appendChild(btnOld);
      overlay.appendChild(btnYoung);
    } else if (type === "cookie") {
      overlay.id = "onetrust-consent-sdk";
      const btn = document.createElement("button");
      btn.id = "onetrust-accept-btn-handler";
      btn.textContent = "I Accept";
      btn.addEventListener("click", closeOverlay);
      overlay.appendChild(btn);
    } else if (type === "generic") {
      overlay.setAttribute("data-testid", "wcl-dialog-overlay");
      overlay.setAttribute("data-state", "open");
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-testid", "wcl-dialog-wrapper");
      const closeBtn = document.createElement("button");
      closeBtn.setAttribute("data-testid", "wcl-dialogCloseButton");
      closeBtn.textContent = "X";
      closeBtn.addEventListener("click", closeOverlay);
      wrapper.appendChild(closeBtn);
      overlay.appendChild(wrapper);
    } else if (type === "unknown") {
      // Deliberately has no id/testid our dismiss functions look for, and no
      // close action — simulates a dialog type we've never seen before.
      const btn = document.createElement("button");
      btn.id = "mystery-dialog-button";
      btn.textContent = "Some new promo we've never seen";
      overlay.appendChild(btn);
    }

    document.body.appendChild(overlay);
  }

  document.getElementById("next-day-btn").addEventListener("click", () => {
    // Mirrors the real site: once there's no further day to page into, the
    // arrow itself goes away rather than staying clickable as a no-op — this
    // is what lets clickNextDayWithRetries's page.$(NEXT_DAY_SELECTOR) check
    // (a null result is a legitimate "end of range", not a failure) actually
    // kick in, instead of waiting out a "nothing changed" timeout.
    if (dayIndex >= days.length - 1) {
      document.getElementById("next-day-btn").remove();
      return;
    }
    dayIndex += 1;
    render();
  });

  render();
  const blockerType = ${JSON.stringify(blockerType)};
  if (blockerType !== "none") injectOverlay(blockerType);
</script>
</body></html>`;
}

// Minimal fixture for testing a single dismiss function in isolation: one
// button (standing in for the day-picker arrow) fully covered by the given
// overlay type from page load. Clicking the button throws (intercepted)
// until the overlay's own close action runs.
export function buildDialogFixtureHtml(overlayType) {
  return buildSchedulePageHtml({
    days: [[{ country: "Brazil", competition: "Brasileirão", matches: [{ id: "abc123", time: "16:00" }] }]],
    blockerType: overlayType,
  });
}

// Builds a match-list page mimicking matches/index.js's results/fixtures
// pages: an initial batch of `.event__match` rows plus a "load more" button
// (`[data-testid="wcl-buttonLink"]`, matching LOAD_MORE_SELECTOR in
// matches/index.js) that appends the next batch on each click. Once the last
// batch has loaded, the button removes itself — same "end of range" signal
// as the day-picker fixture above, and for the same reason: it's what lets
// clickLoadMoreWithRetries's page.$(selector) check treat "no button" as a
// legitimate stop condition rather than a failure. `blockerType` reuses the
// same overlay types (age/cookie/generic/unknown) as buildDialogFixtureHtml
// to exercise clickLoadMoreWithRetries's overlay recovery.
export function buildMatchListPageHtml({ batches, blockerType = "none" }) {
  return `<!doctype html>
<html><body>
<div id="root"></div>
<button data-testid="wcl-buttonLink" id="load-more-btn"></button>
<script>
  const batches = ${JSON.stringify(batches)};
  let batchIndex = 0;

  function renderBatch(batch) {
    const root = document.getElementById("root");
    batch.forEach((m) => {
      const row = document.createElement("div");
      row.id = "g_1_" + m.id;
      row.className = "event__match event__match--withRowLink event__match--twoLine";
      const link = document.createElement("a");
      link.className = "eventRowLink";
      link.href = "https://www.flashscore.com/match/football/" + m.id + "/?mid=" + m.id;
      // Real match rows always render visible text (team names, time, ...),
      // which is what gives them a non-zero layout box. A childless <a> with
      // no text content collapses to zero size, which Playwright's default
      // waitForSelector({state: "visible"}) treats as *hidden* — that would
      // make getMatchLinks' post-loop waitForSelectorSafe(page, [MATCH_SELECTOR])
      // spuriously warn "selector never appeared" even though the row is very
      // much in the DOM and read fine by page.evaluate(). This text node is
      // only here to keep the fixture's rows visible, matching real markup.
      link.textContent = m.id;
      row.appendChild(link);
      root.appendChild(row);
    });
  }

  function closeOverlay() {
    const el = document.querySelector(".blocking-overlay");
    if (el) el.remove();
  }

  function injectOverlay(type) {
    const overlay = document.createElement("div");
    overlay.classList.add("blocking-overlay");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "9999";
    overlay.style.background = "rgba(0,0,0,0.4)";

    if (type === "age") {
      overlay.setAttribute("data-testid", "wcl-dialog-overlay");
      overlay.setAttribute("data-state", "open");
      const btnOld = document.createElement("button");
      btnOld.setAttribute("data-testid", "wcl-button");
      btnOld.textContent = "I'M 18 AND OLDER";
      btnOld.addEventListener("click", closeOverlay);
      const btnYoung = document.createElement("button");
      btnYoung.setAttribute("data-testid", "wcl-button");
      btnYoung.textContent = "I'M YOUNGER THAN 18";
      overlay.appendChild(btnOld);
      overlay.appendChild(btnYoung);
    } else if (type === "cookie") {
      overlay.id = "onetrust-consent-sdk";
      const btn = document.createElement("button");
      btn.id = "onetrust-accept-btn-handler";
      btn.textContent = "I Accept";
      btn.addEventListener("click", closeOverlay);
      overlay.appendChild(btn);
    } else if (type === "generic") {
      overlay.setAttribute("data-testid", "wcl-dialog-overlay");
      overlay.setAttribute("data-state", "open");
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-testid", "wcl-dialog-wrapper");
      const closeBtn = document.createElement("button");
      closeBtn.setAttribute("data-testid", "wcl-dialogCloseButton");
      closeBtn.textContent = "X";
      closeBtn.addEventListener("click", closeOverlay);
      wrapper.appendChild(closeBtn);
      overlay.appendChild(wrapper);
    } else if (type === "unknown") {
      // Deliberately has no id/testid our dismiss functions look for, and no
      // close action — simulates a dialog type we've never seen before.
      const btn = document.createElement("button");
      btn.id = "mystery-dialog-button";
      btn.textContent = "Some new promo we've never seen";
      overlay.appendChild(btn);
    }

    document.body.appendChild(overlay);
  }

  document.getElementById("load-more-btn").addEventListener("click", () => {
    const nextIndex = batchIndex + 1;
    if (nextIndex >= batches.length) {
      document.getElementById("load-more-btn").remove();
      return;
    }
    batchIndex = nextIndex;
    renderBatch(batches[batchIndex]);
    if (batchIndex >= batches.length - 1) {
      document.getElementById("load-more-btn").remove();
    }
  });

  renderBatch(batches[0]);
  const blockerType = ${JSON.stringify(blockerType)};
  if (blockerType !== "none") injectOverlay(blockerType);
</script>
</body></html>`;
}

// A page with none of the expected schedule markup at all — used to test the
// "layout changed" branch of diagnoseScrapePage/waitForSelectorSafe.
export function buildUnexpectedLayoutHtml() {
  return `<!doctype html><html><body><div id="totally-different-app"></div></body></html>`;
}

// A page whose text mimics a Flashscore rate-limit/blocking response — used
// to test the "blocked" branch of diagnoseScrapePage.
export function buildRateLimitedPageHtml() {
  return `<!doctype html><html><head><title>Too Many Requests</title></head><body><p>You have sent too many requests. Please try again later.</p></body></html>`;
}
