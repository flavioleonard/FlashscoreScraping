import { test, expect } from "@playwright/test";
import { getMatchesForDay } from "../src/scraper/services/schedule/index.js";
import { BASE_URL } from "../src/constants/index.js";
import { buildSchedulePageHtml } from "./fixtures.js";

async function mockSchedulePage(context, html) {
  await context.route(BASE_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
  );
}

test("extracts matches with the right id/url/time, grouped by the preceding league wrapper", async ({
  context,
}) => {
  const html = buildSchedulePageHtml({
    days: [
      [
        {
          country: "Brazil",
          competition: "Brasileirão Série A",
          matches: [
            { id: "aaa111", time: "16:00" },
            { id: "bbb222", time: "18:30" },
          ],
        },
        {
          country: "England",
          competition: "Premier League",
          matches: [{ id: "ccc333", time: "20:00" }],
        },
      ],
    ],
  });
  await mockSchedulePage(context, html);

  const matches = await getMatchesForDay(context, 0);

  expect(matches).toEqual([
    {
      id: "aaa111",
      url: "https://www.flashscore.com/match/football/aaa111/?mid=aaa111",
      time: "16:00",
      country: "Brazil",
      competition: "Brasileirão Série A",
    },
    {
      id: "bbb222",
      url: "https://www.flashscore.com/match/football/bbb222/?mid=bbb222",
      time: "18:30",
      country: "Brazil",
      competition: "Brasileirão Série A",
    },
    {
      id: "ccc333",
      url: "https://www.flashscore.com/match/football/ccc333/?mid=ccc333",
      time: "20:00",
      country: "England",
      competition: "Premier League",
    },
  ]);
});

test("advances the day-picker dayOffset times and returns that day's matches", async ({ context }) => {
  const html = buildSchedulePageHtml({
    days: [
      [{ country: "Brazil", competition: "Série A", matches: [{ id: "day0", time: "16:00" }] }],
      [{ country: "Brazil", competition: "Série A", matches: [{ id: "day1", time: "16:00" }] }],
      [{ country: "Brazil", competition: "Série A", matches: [{ id: "day2", time: "16:00" }] }],
    ],
  });
  await mockSchedulePage(context, html);

  const matches = await getMatchesForDay(context, 2);

  expect(matches.map((m) => m.id)).toEqual(["day2"]);
});

test("stays on the last available day once the day-picker runs out of days", async ({ context }) => {
  const html = buildSchedulePageHtml({
    days: [
      [{ country: "Brazil", competition: "Série A", matches: [{ id: "onlyday", time: "16:00" }] }],
    ],
  });
  await mockSchedulePage(context, html);

  const matches = await getMatchesForDay(context, 5);

  expect(matches.map((m) => m.id)).toEqual(["onlyday"]);
});

test("recovers from an overlay blocking the day-picker and still advances", async ({ context }) => {
  const html = buildSchedulePageHtml({
    days: [
      [{ country: "Brazil", competition: "Série A", matches: [{ id: "day0", time: "16:00" }] }],
      [{ country: "Brazil", competition: "Série A", matches: [{ id: "day1", time: "16:00" }] }],
    ],
    blockerType: "age",
  });
  await mockSchedulePage(context, html);

  const matches = await getMatchesForDay(context, 1);

  expect(matches.map((m) => m.id)).toEqual(["day1"]);
});

test("skips match rows missing an id or link instead of throwing", async ({ context }) => {
  const html = `<!doctype html><html><body>
    <div class="sportName soccer">
      <div class="headerLeague__wrapper">
        <span class="headerLeague__flag" title="Brazil"></span>
        <span class="headerLeague__title-text">Série A</span>
      </div>
      <div id="g_1_valid1" class="event__match event__match--withRowLink event__match--twoLine">
        <a class="eventRowLink" href="https://www.flashscore.com/match/football/valid1/?mid=valid1"></a>
        <div class="event__time">16:00</div>
      </div>
      <div id="g_1_broken" class="event__match event__match--withRowLink event__match--twoLine">
        <div class="event__time">17:00</div>
      </div>
    </div>
    <button data-day-picker-arrow="next"></button>
  </body></html>`;
  await mockSchedulePage(context, html);

  const matches = await getMatchesForDay(context, 0);

  expect(matches.map((m) => m.id)).toEqual(["valid1"]);
});
