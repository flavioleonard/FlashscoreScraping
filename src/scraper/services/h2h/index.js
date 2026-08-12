import { TIMEOUT } from "../../../constants/index.js";
import { openPageAndNavigate, waitForSelectorSafe } from "../../index.js";

const SECTION_SELECTOR = ".h2h__section";
const ROW_SELECTOR = ".h2h__row";
const SHOW_MORE_SELECTOR = '[data-testid="wcl-buttonLink"]';
// 5 rows load initially per section; each click adds 5 more. 2 clicks (15
// rows total) is plenty for any draw/outcome streak our algorithms look at.
const MAX_SHOW_MORE_CLICKS = 2;

// Section order on the "overall" H2H tab is always:
// 0 = last matches of the home team, 1 = last matches of the away team,
// 2 = head-to-head matches between the two.
const SECTION_HOME = 0;
const SECTION_AWAY = 1;
const SECTION_H2H = 2;

export const buildH2HUrl = (matchUrl) => {
  if (!matchUrl) return null;

  const url = new URL(matchUrl);
  const base = url.origin + url.pathname.replace(/\/$/, "");
  const mid = url.searchParams.get("mid");

  return `${base}/h2h/overall/?mid=${mid}`;
};

// H2H rows show "DD.MM.YY" (2-digit year) instead of the "DD.MM.YYYY HH:MM"
// used everywhere else in this scraper's output — normalize so downstream
// consumers can keep using the same date parsing for both.
export const normalizeH2HDate = (shortDate) => {
  const match = shortDate?.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!match) return shortDate ?? "";

  const [, day, month, year] = match;
  return `${day}.${month}.20${year} 00:00`;
};

const expandSection = async (page, sectionIndex) => {
  for (let i = 0; i < MAX_SHOW_MORE_CLICKS; i += 1) {
    const section = (await page.$$(SECTION_SELECTOR))[sectionIndex];
    if (!section) break;

    const button = await section.$(SHOW_MORE_SELECTOR);
    if (!button) break;

    const countBefore = await section.$$eval(ROW_SELECTOR, (els) => els.length);

    try {
      await button.click();
    } catch {
      break;
    }

    try {
      await page.waitForFunction(
        ({ selector, prevCount, idx }) => {
          const sections = document.querySelectorAll(selector);
          return (sections[idx]?.querySelectorAll(".h2h__row").length ?? 0) > prevCount;
        },
        { selector: SECTION_SELECTOR, prevCount: countBefore, idx: sectionIndex },
        { timeout: TIMEOUT }
      );
    } catch {
      break;
    }
  }
};

const extractSection = async (page, sectionIndex) => {
  return page.evaluate(
    ({ selector, idx }) => {
      const section = document.querySelectorAll(selector)[idx];
      if (!section) return [];

      return Array.from(section.querySelectorAll(".h2h__row")).map((row) => {
        const home = row
          .querySelector(".h2h__homeParticipant [data-testid='wcl-scores-simple-text-01']")
          ?.innerText.trim();
        const away = row
          .querySelector(".h2h__awayParticipant [data-testid='wcl-scores-simple-text-01']")
          ?.innerText.trim();
        const scores = Array.from(
          row.querySelectorAll(".h2h__result [data-testid='wcl-tableScore']")
        ).map((s) => s.innerText.trim());

        return {
          date: row.querySelector(".wclH2h__date")?.innerText.trim(),
          competition: row.querySelector(".h2h__event")?.getAttribute("title") ?? null,
          home,
          away,
          homeScore: scores[0],
          awayScore: scores[1],
        };
      });
    },
    { selector: SECTION_SELECTOR, idx: sectionIndex }
  );
};

const toRawMatch = (row) => ({
  date: normalizeH2HDate(row.date),
  status: "FINISHED",
  home: { name: row.home },
  away: { name: row.away },
  result: { home: row.homeScore, away: row.awayScore },
  competition: row.competition,
});

// Reads the "Overall" H2H tab for a match: last games of the home team, last
// games of the away team (both cross-competition, aggregated by Flashscore
// itself), and their head-to-head history — everything a "next match" needs
// to compute a draw-streak signal, without us having to reconcile separate
// per-competition scrape files.
export const getH2HData = async (context, matchUrl) => {
  const h2hUrl = buildH2HUrl(matchUrl);
  const page = await openPageAndNavigate(context, h2hUrl);

  await waitForSelectorSafe(page, [".duelParticipant__startTime", SECTION_SELECTOR], TIMEOUT);

  const match = await page.evaluate(() => ({
    home: document
      .querySelector(".duelParticipant__home .participant__participantName")
      ?.innerText.trim(),
    away: document
      .querySelector(".duelParticipant__away .participant__participantName")
      ?.innerText.trim(),
    date: document.querySelector(".duelParticipant__startTime")?.innerText.trim(),
    status:
      document.querySelector(".fixedHeaderDuel__detailStatus")?.innerText.trim() ??
      "NOT STARTED",
  }));

  await expandSection(page, SECTION_HOME);
  await expandSection(page, SECTION_AWAY);
  await expandSection(page, SECTION_H2H);

  const [lastMatchesHome, lastMatchesAway, headToHead] = await Promise.all([
    extractSection(page, SECTION_HOME),
    extractSection(page, SECTION_AWAY),
    extractSection(page, SECTION_H2H),
  ]);

  await page.close();

  return {
    match,
    lastMatchesHome: lastMatchesHome.map(toRawMatch),
    lastMatchesAway: lastMatchesAway.map(toRawMatch),
    headToHead: headToHead.map(toRawMatch),
  };
};
