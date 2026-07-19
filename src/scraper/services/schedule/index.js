import { BASE_URL, TIMEOUT } from "../../../constants/index.js";
import { openPageAndNavigate, waitForSelectorSafe } from "../../index.js";

const MATCH_SELECTOR =
  ".event__match.event__match--withRowLink.event__match--twoLine";
const NEXT_DAY_SELECTOR = '[data-day-picker-arrow="next"]';
const LEAGUE_WRAPPER_SELECTOR = ".headerLeague__wrapper";

// Navigates the homepage day-picker forward `dayOffset` days (0 = today) and
// lists every football match scheduled for that day, across every
// country/competition the site shows — no "load more" here, the whole day
// renders in one shot. Each match is tagged with the country/competition of
// the .headerLeague__wrapper it's nested under.
export const getMatchesForDay = async (context, dayOffset = 0) => {
  const page = await openPageAndNavigate(context, BASE_URL);
  await waitForSelectorSafe(page, [MATCH_SELECTOR], TIMEOUT);

  for (let i = 0; i < dayOffset; i += 1) {
    const nextButton = await page.$(NEXT_DAY_SELECTOR);
    if (!nextButton) break;

    try {
      await nextButton.click();
    } catch {
      break;
    }

    await page.waitForTimeout(2000);
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
