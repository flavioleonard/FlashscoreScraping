import { TIMEOUT } from "../../../constants/index.js";
import {
  diagnoseScrapePage,
  dismissAgeVerificationIfPresent,
  dismissCookieConsentIfPresent,
  dismissGenericDialogIfPresent,
  openPageAndNavigate,
  waitForSelectorSafe,
} from "../../index.js";

const MAX_LOAD_MORE_CLICK_ATTEMPTS = 3;

// Mechanically identical to clickNextDayWithRetries in schedule/index.js:
// the "load more" pagination button is a real hit-tested Playwright click,
// and it turns out to be blocked by the exact same site-wide overlays (age
// gate, cookie consent, generic dialogs) as the day-picker's "next" arrow
// was — see the BUG FIX note in schedule/index.js for how that one went
// unnoticed for weeks. A bare `click(); catch { break; }` here would
// reproduce that same silent-failure shape: pagination would quietly stop
// after whatever page happened to be on screen when an overlay first
// mounted, with zero error output. Retry a few times, re-running all known
// dismissals between attempts, and warn loudly (with a live diagnosis) if
// every attempt still fails instead of breaking silently.
async function clickLoadMoreWithRetries(page, selector) {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_LOAD_MORE_CLICK_ATTEMPTS; attempt += 1) {
    const loadMoreBtn = await page.$(selector);
    // No button at all is a legitimate end state (no more pages to load),
    // not a failure — nothing to warn about.
    if (!loadMoreBtn) return false;

    try {
      await loadMoreBtn.click({ timeout: 10000 });
      return true;
    } catch (error) {
      lastError = error;
      await dismissAgeVerificationIfPresent(page);
      await dismissCookieConsentIfPresent(page);
      await dismissGenericDialogIfPresent(page);
    }
  }

  // The button existed but every click attempt failed — always a real
  // problem (an overlay we don't know how to dismiss, or something else
  // blocking the page). Warn loudly with a live diagnosis instead of
  // silently keeping whatever matches had already loaded.
  const diagnosis = await diagnoseScrapePage(page);
  console.warn(
    `⚠️  Não foi possível clicar em "load more" após ${MAX_LOAD_MORE_CLICK_ATTEMPTS} tentativas ` +
      `(último erro: ${lastError?.message?.split("\n")[0] ?? "desconhecido"}). ${diagnosis}`
  );
  return false;
}

export const getMatchLinks = async (context, leagueSeasonUrl, type) => {
  const page = await openPageAndNavigate(context, `${leagueSeasonUrl}/${type}`);

  const LOAD_MORE_SELECTOR = '[data-testid="wcl-buttonLink"]';
  const MATCH_SELECTOR =
    ".event__match.event__match--withRowLink.event__match--twoLine";
  const MAX_EMPTY_CYCLES = 4;

  // The list is client-rendered, so right after navigation there may be
  // neither matches nor the "load more" button in the DOM yet. Without this
  // wait the loop below sees no button, exits immediately, and only the
  // first lazily-rendered batch ever gets collected.
  await waitForSelectorSafe(page, [MATCH_SELECTOR, LOAD_MORE_SELECTOR], TIMEOUT);

  let emptyCycles = 0;

  while (true) {
    const countBefore = await page.$$eval(MATCH_SELECTOR, (els) => els.length);

    const clicked = await clickLoadMoreWithRetries(page, LOAD_MORE_SELECTOR);
    if (!clicked) break;

    // Wait for the match count to actually grow instead of a fixed delay:
    // on a loaded system the new rows can take longer than a flat timeout
    // to render, which previously made this loop give up after only one page.
    try {
      await page.waitForFunction(
        ({ selector, prevCount }) =>
          document.querySelectorAll(selector).length > prevCount,
        { selector: MATCH_SELECTOR, prevCount: countBefore },
        { timeout: TIMEOUT }
      );
      emptyCycles = 0;
    } catch {
      emptyCycles++;
      if (emptyCycles >= MAX_EMPTY_CYCLES) break;
    }
  }

  await waitForSelectorSafe(page, [MATCH_SELECTOR]);

  const matchIdList = await page.evaluate(() => {
    return Array.from(
      document.querySelectorAll(
        ".event__match.event__match--withRowLink.event__match--twoLine"
      )
    ).map((element) => {
      const id = element?.id?.replace("g_1_", "");
      const url = element.querySelector("a.eventRowLink")?.href ?? null;
      return { id, url };
    });
  });

  await page.close();

  console.info(`✅ Found ${matchIdList.length} matches for ${type}`);
  return matchIdList;
};

export const getMatchData = async (context, { id: matchId, url }) => {
  const page = await openPageAndNavigate(context, url);

  await waitForSelectorSafe(page, [
    ".duelParticipant__startTime",
    "div[data-testid='wcl-summaryMatchInformation'] > div'",
  ]);

  const matchData = await extractMatchData(page);
  const information = await extractMatchInformation(page);

  const statsLink = buildStatsUrl(url);
  await page.goto(statsLink, { waitUntil: "domcontentloaded" });

  await waitForSelectorSafe(page, [
    "div[data-testid='wcl-statistics']",
    "div[data-testid='wcl-statistics-value']",
  ]);

  const statistics = await extractMatchStatistics(page);

  await page.close();
  return { matchId, ...matchData, information, statistics };
};

export const buildStatsUrl = (matchUrl) => {
  if (!matchUrl) return null;

  const url = new URL(matchUrl);
  const base = url.origin + url.pathname.replace(/\/$/, "");
  const mid = url.searchParams.get("mid");
  // Without this check, a matchUrl missing `mid` silently produces the
  // literal string "...mid=null" instead of failing clearly — the resulting
  // page load would then 404 or serve garbage with no indication why.
  // Returning null matches the "no matchUrl provided" convention above, so
  // callers get one clean, checkable "can't build this URL" signal either way.
  if (!mid) return null;

  return `${base}/summary/stats/?mid=${mid}`;
};

const extractMatchData = async (page) => {
  await waitForSelectorSafe(page, [
    "span[data-testid='wcl-scores-overline-03']",
    ".duelParticipant__startTime",
    ".fixedHeaderDuel__detailStatus",
    ".tournamentHeader__country > a",
    ".detailScore__wrapper span:not(.detailScore__divider)",
    ".duelParticipant__home .participant__image",
    ".duelParticipant__away .participant__image",
    ".duelParticipant__home .participant__participantName.participant__overflow",
    ".duelParticipant__away .participant__participantName.participant__overflow",
  ]);

  return await page.evaluate(() => {
    return {
      stage: Array.from(
        document.querySelectorAll("span[data-testid='wcl-scores-overline-03']")
      )?.[2]
        ?.innerText.trim()
        ?.split(" - ")
        .pop()
        .trim(),
      date: document
        .querySelector(".duelParticipant__startTime")
        ?.innerText.trim(),
      status:
        document
          .querySelector(".fixedHeaderDuel__detailStatus")
          ?.innerText.trim() ?? "NOT STARTED",
      home: {
        name: document
          .querySelector(
            ".duelParticipant__home .participant__participantName.participant__overflow"
          )
          ?.innerText.trim(),
        image: document.querySelector(
          ".duelParticipant__home .participant__image"
        )?.src,
      },
      away: {
        name: document
          .querySelector(
            ".duelParticipant__away .participant__participantName.participant__overflow"
          )
          ?.innerText.trim(),
        image: document.querySelector(
          ".duelParticipant__away .participant__image"
        )?.src,
      },
      result: {
        home: Array.from(
          document.querySelectorAll(
            ".detailScore__wrapper span:not(.detailScore__divider)"
          )
        )?.[0]?.innerText.trim(),
        away: Array.from(
          document.querySelectorAll(
            ".detailScore__wrapper span:not(.detailScore__divider)"
          )
        )?.[1]?.innerText.trim(),
        regulationTime: document
          .querySelector(".detailScore__fullTime")
          ?.innerText.trim()
          .replace(/[\n()]/g, ""),
        penalties: Array.from(
          document.querySelectorAll('[data-testid="wcl-scores-overline-02"]')
        )
          .find(
            (element) => element.innerText.trim().toLowerCase() === "penalties"
          )
          ?.nextElementSibling?.innerText?.trim()
          .replace(/\s+/g, ""),
      },
    };
  });
};

const extractMatchInformation = async (page) => {
  return await page.evaluate(async () => {
    const elements = Array.from(
      document.querySelectorAll(
        "div[data-testid='wcl-summaryMatchInformation'] > div"
      )
    );
    return elements.reduce((acc, element, index) => {
      if (index % 2 === 0) {
        acc.push({
          category: element?.textContent
            .trim()
            .replace(/\s+/g, " ")
            .replace(/(^[:\s]+|[:\s]+$|:)/g, ""),
          value: elements[index + 1]?.innerText
            .trim()
            .replace(/\s+/g, " ")
            .replace(/(^[:\s]+|[:\s]+$|:)/g, ""),
        });
      }
      return acc;
    }, []);
  });
};

const extractMatchStatistics = async (page) => {
  return await page.evaluate(async () => {
    return Array.from(
      document.querySelectorAll("div[data-testid='wcl-statistics']")
    ).map((element) => {
      // Each side's value div can hold more than one <span> (e.g. "Passes"
      // shows a percentage plus a "(x/y)" breakdown) — take only the first
      // span *within each side's own div*, not the first two spans in the
      // row, otherwise a two-span stat yields two home values instead of
      // one home and one away.
      const valueDivs = Array.from(
        element.querySelectorAll("div[data-testid='wcl-statistics-value']")
      );
      const readValue = (div) => div?.querySelector("span")?.innerText.trim();

      return {
        category: element
          .querySelector("div[data-testid='wcl-statistics-category']")
          ?.innerText.trim(),
        homeValue: readValue(valueDivs[0]),
        awayValue: readValue(valueDivs[1]),
      };
    });
  });
};
