import { TIMEOUT } from "../constants/index.js";

// Text that shows up on Flashscore's own rate-limit/blocking pages, as
// opposed to a normal page that simply hasn't rendered our selector yet.
// Checked against both the page title and a body-text snippet.
const BLOCKED_TEXT_PATTERNS = [
  /too many requests/i,
  /rate limit/i,
  /access denied/i,
  /unusual traffic/i,
  /captcha/i,
  /temporarily unavailable/i,
];

export const openPageAndNavigate = async (context, url) => {
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  // Stashed on the page itself (rather than returned separately) so every
  // existing call site — `const page = await openPageAndNavigate(...)` — goes
  // on working unchanged, while diagnoseScrapePage below can still read it.
  page.__lastResponseStatus = response?.status() ?? null;
  return page;
};

export const waitAndClick = async (page, selector, timeout = TIMEOUT) => {
  await page.waitForSelector(selector, { timeout });
  await page.evaluate(async (selector) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const element = document.querySelector(selector);
    if (element) {
      element.scrollIntoView();
      element.click();
    }
  }, selector);
};

// Flashscore's age-verification gate (a "wcl-dialog" overlay asking to
// confirm your age) sits on top of real hit-tested clicks (the day-picker
// arrow, the "load more" pagination button, ...) and intercepts their
// pointer events. There's no stable data-testid for the specific button (the
// dialog's two buttons share data-testid="wcl-button"), so we match by text —
// on the stable "AND OLDER" suffix rather than a specific age, since the site
// already changed the threshold once ("24 AND OLDER" -> "18 AND OLDER"). Both
// dialogs can mount a beat after the underlying content does, so we use
// locators (which actively wait/retry) rather than a one-shot querySelector
// check — a single snapshot check right after content appears can race the
// dialog's own mount and silently miss it.
//
// These three dismiss functions live here (rather than in a single call
// site's module) because the overlays they handle are generic, site-wide
// nuisances — not specific to any one scraping flow. They started out in
// schedule/index.js (where the day-picker "next" click was the first real
// click found to be affected) and were moved here once matches/index.js's
// "load more" pagination click turned out to be blocked by the exact same
// overlays.
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

// Builds a human-readable explanation of why a page isn't showing what we
// expected — used whenever a critical selector never appears, so scraping
// failures say WHY instead of just "timeout exceeded". Three broad causes,
// checked in order: (1) the navigation itself failed (bad HTTP status), (2)
// the page loaded but Flashscore served a rate-limit/blocking page instead of
// real content, (3) the page loaded normal-looking content but the specific
// selector we expected isn't in it — usually a sign the site's markup
// changed underneath us (see "Bugs encontrados..." in the sibling
// bet-predictor repo's CLAUDE.md for past examples of exactly this).
export const diagnoseScrapePage = async (page) => {
  const status = page.__lastResponseStatus ?? null;
  const [title, bodyText] = await Promise.all([
    page.title().catch(() => "(não foi possível ler o título)"),
    page
      .evaluate(() => document.body?.innerText?.slice(0, 300) ?? "")
      .catch(() => "(não foi possível ler o corpo da página)"),
  ]);

  if (status !== null && status >= 400) {
    return `HTTP ${status} em ${page.url()} — possível bloqueio ou rate-limit do Flashscore.`;
  }

  const blockedMatch = BLOCKED_TEXT_PATTERNS.find(
    (pattern) => pattern.test(title) || pattern.test(bodyText)
  );
  if (blockedMatch) {
    return (
      `Página de ${page.url()} parece ser um bloqueio/rate-limit do Flashscore ` +
      `(título: "${title}", trecho: "${bodyText.slice(0, 150)}").`
    );
  }

  return (
    `Página de ${page.url()} carregou (status ${status ?? "desconhecido"}, ` +
    `título: "${title}") mas o conteúdo esperado não apareceu — possível ` +
    `mudança de layout do Flashscore. Trecho do corpo: "${bodyText.slice(0, 150)}"`
  );
};

// "Safe" because it never throws — some callers pass several ALTERNATIVE
// selectors where finding just one of them is the expected, healthy outcome
// (e.g. matches/index.js waits for either the match list or the "load more"
// button, whichever shows up first). Failing to find ANY of the given
// selectors, though, is never a healthy outcome — it means the page didn't
// render what we came for at all — so that specific case gets a loud,
// diagnostic console.warn instead of vanishing into an empty catch block
// (which is exactly how bug #9 — scan-h2h silently losing D+1/D+2/D+3 to an
// unhandled overlay — went unnoticed for weeks: everything downstream just
// kept running on an empty/stale page with no indication anything was wrong).
export const waitForSelectorSafe = async (
  page,
  selectors = [],
  timeout = TIMEOUT
) => {
  const found = await Promise.all(
    selectors.map(async (selector) => {
      try {
        await page.waitForSelector(selector, { timeout });
        return true;
      } catch {
        return false;
      }
    })
  );

  if (selectors.length > 0 && !found.some(Boolean)) {
    const diagnosis = await diagnoseScrapePage(page);
    console.warn(
      `⚠️  Nenhum dos seletores esperados (${selectors.join(", ")}) apareceu após ${timeout}ms. ${diagnosis}`
    );
  }
};
