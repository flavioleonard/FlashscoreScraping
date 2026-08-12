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
