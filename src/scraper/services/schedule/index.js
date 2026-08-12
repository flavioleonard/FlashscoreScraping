import { BASE_URL, TIMEOUT } from "../../../constants/index.js";
import { diagnoseScrapePage, openPageAndNavigate, waitForSelectorSafe } from "../../index.js";

const MATCH_SELECTOR =
  ".event__match.event__match--withRowLink.event__match--twoLine";
const NEXT_DAY_SELECTOR = '[data-day-picker-arrow="next"]';
const LEAGUE_WRAPPER_SELECTOR = ".headerLeague__wrapper";
// Flashscore's age-verification gate (a "wcl-dialog" overlay asking to
// confirm your age) sits on top of the day-picker arrow and intercepts its
// pointer events. There's no stable data-testid for the specific button (the
// dialog's two buttons share data-testid="wcl-button"), so we match by text —
// on the stable "AND OLDER" suffix rather than a specific age, since the site
// already changed the threshold once ("24 AND OLDER" -> "18 AND OLDER"). Both
// dialogs can mount a beat after the match rows do, so we use locators (which
// actively wait/retry) rather than a one-shot querySelector check — a single
// snapshot check right after the match rows appear can race the dialog's own
// mount and silently miss it.
const AGE_VERIFICATION_BUTTON_TEXT = /AND OLDER/i;
// A second, independent overlay (OneTrust cookie consent banner) also sits on
// top of the page and intercepts clicks — has its own stable button id.
const COOKIE_CONSENT_ACCEPT_SELECTOR = "#onetrust-accept-btn-handler";
const DIALOG_DISMISS_TIMEOUT = 5000;

export async function dismissAgeVerificationIfPresent(page) {
  await page
    .locator('[data-testid="wcl-button"]')
    .filter({ hasText: AGE_VERIFICATION_BUTTON_TEXT })
    .first()
    .click({ timeout: DIALOG_DISMISS_TIMEOUT })
    .catch(() => {});
}

export async function dismissCookieConsentIfPresent(page) {
  await page
    .locator(COOKIE_CONSENT_ACCEPT_SELECTOR)
    .click({ timeout: DIALOG_DISMISS_TIMEOUT })
    .catch(() => {});
}

// Flashscore also shows other one-off dialogs built on the same generic
// "wcl-dialog" component — e.g. a locale-redirect prompt ("Lançamos um
// Flashscore Brasil...", confirmed live) that has nothing to do with age or
// cookies, so neither dismissal above matches it. Unlike the age gate (a
// forced either/or choice with no close button), these generic dialogs carry
// a stable close-button testid — clicking it declines whatever the dialog is
// offering and leaves the page as-is, which is what we want in every case
// (we never want to actually follow a locale redirect mid-scrape). This is a
// catch-all for dialog types we haven't specifically identified yet, not a
// replacement for the two dismissals above.
const GENERIC_DIALOG_CLOSE_SELECTOR = '[data-testid="wcl-dialogCloseButton"]';

export async function dismissGenericDialogIfPresent(page) {
  await page
    .locator(GENERIC_DIALOG_CLOSE_SELECTOR)
    .first()
    .click({ timeout: DIALOG_DISMISS_TIMEOUT })
    .catch(() => {});
}

function matchIdsFingerprint(page) {
  return page.evaluate(
    (selector) => Array.from(document.querySelectorAll(selector)).map((e) => e.id),
    MATCH_SELECTOR
  );
}

const MAX_NEXT_DAY_CLICK_ATTEMPTS = 3;

// These overlays don't just show once on first page load — they can also
// re-mount later (mid-session, on a page that already dismissed them once),
// so a single dismiss-then-click is not enough: a click can still get
// intercepted by an overlay that (re)appeared after our earlier dismissal.
// Retry the click a few times, re-running both dismissals between attempts,
// before giving up on advancing to the next day.
export async function clickNextDayWithRetries(page) {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_NEXT_DAY_CLICK_ATTEMPTS; attempt += 1) {
    const nextButton = await page.$(NEXT_DAY_SELECTOR);
    // No button at all is a legitimate end state (Flashscore's day-picker has
    // a finite range), not a failure — nothing to warn about.
    if (!nextButton) return false;

    try {
      await nextButton.click({ timeout: 10000 });
      return true;
    } catch (error) {
      lastError = error;
      await dismissAgeVerificationIfPresent(page);
      await dismissCookieConsentIfPresent(page);
      await dismissGenericDialogIfPresent(page);
    }
  }

  // The button existed but every click attempt failed — unlike the "no
  // button" case above, this is always a real problem (an overlay we don't
  // know how to dismiss, or something else blocking the page). Warn loudly
  // with a live diagnosis instead of letting the caller silently keep
  // whatever day it was already on (which is exactly how bug #9 went
  // unnoticed for weeks).
  const diagnosis = await diagnoseScrapePage(page);
  console.warn(
    `⚠️  Não foi possível avançar o day-picker após ${MAX_NEXT_DAY_CLICK_ATTEMPTS} tentativas ` +
      `(último erro: ${lastError?.message?.split("\n")[0] ?? "desconhecido"}). ${diagnosis}`
  );
  return false;
}

// Navigates the homepage day-picker forward `dayOffset` days (0 = today) and
// lists every football match scheduled for that day, across every
// country/competition the site shows — no "load more" here, the whole day
// renders in one shot. Each match is tagged with the country/competition of
// the .headerLeague__wrapper it's nested under.
//
// BUG FIX (found investigating "days=1-2 always returns day 0's matches"):
// a modal overlay intercepts the day-picker arrow's pointer events, so
// `nextButton.click()` threw and was silently swallowed by the catch/break,
// leaving every dayOffset >= 1 stuck on whatever day was already on screen.
// There isn't just one such overlay — confirmed live, across a handful of
// sequential calls in the same browser context: the age-verification gate,
// an independent OneTrust cookie-consent banner, AND a locale-redirect promo
// ("Lançamos um Flashscore Brasil...", likely geo-IP-triggered) all showed up
// at different points, none of them reliably only-once. A single
// dismiss-then-click is NOT enough — any of these can (re)mount asynchronously
// mid-session, including on a page that already cleanly dismissed one before —
// hence the retry loop in `clickNextDayWithRetries`, which re-runs all known
// dismissals between attempts instead of assuming one pass holds for the rest
// of the page's lifetime. Waiting for the match list to actually change
// (instead of a flat timeout) avoids a second failure mode where the page
// hadn't finished re-rendering yet.
export const getMatchesForDay = async (context, dayOffset = 0) => {
  const page = await openPageAndNavigate(context, BASE_URL);
  await waitForSelectorSafe(page, [MATCH_SELECTOR], TIMEOUT);
  await dismissAgeVerificationIfPresent(page);
  await dismissCookieConsentIfPresent(page);
  await dismissGenericDialogIfPresent(page);

  for (let i = 0; i < dayOffset; i += 1) {
    const beforeIds = await matchIdsFingerprint(page);
    const clicked = await clickNextDayWithRetries(page);
    if (!clicked) break;

    await page
      .waitForFunction(
        ({ selector, previousIds }) => {
          const current = Array.from(document.querySelectorAll(selector)).map((e) => e.id);
          return current.length > 0 && JSON.stringify(current) !== previousIds;
        },
        { selector: MATCH_SELECTOR, previousIds: JSON.stringify(beforeIds) },
        { timeout: TIMEOUT }
      )
      .catch(() => {});
  }

  await waitForSelectorSafe(page, [MATCH_SELECTOR], TIMEOUT);

  const matches = await page.evaluate(
    ({ matchSelector, leagueWrapperSelector }) => {
      // .headerLeague__wrapper and .event__match rows are SIBLINGS under a
      // shared container (div.sportName.soccer), not nested — each match
      // belongs to whichever wrapper most recently preceded it in document
      // order, until the next wrapper starts a new competition group.
      const results = [];
      const container = document.querySelector(".sportName.soccer") ?? document.body;

      let country = null;
      let competition = null;

      Array.from(container.children).forEach((child) => {
        if (child.matches(leagueWrapperSelector)) {
          country = child.querySelector(".headerLeague__flag")?.getAttribute("title") ?? null;
          competition = child.querySelector(".headerLeague__title-text")?.innerText.trim() ?? null;
          return;
        }

        if (!child.matches(matchSelector)) return;

        const id = child.id?.replace("g_1_", "");
        const url = child.querySelector("a.eventRowLink")?.href ?? null;
        const time = child.querySelector(".event__time")?.innerText.trim();
        if (!id || !url) return;

        results.push({ id, url, time, country, competition });
      });

      return results;
    },
    { matchSelector: MATCH_SELECTOR, leagueWrapperSelector: LEAGUE_WRAPPER_SELECTOR }
  );

  await page.close();

  console.info(`✅ Found ${matches.length} matches for day offset ${dayOffset}`);
  return matches;
};
