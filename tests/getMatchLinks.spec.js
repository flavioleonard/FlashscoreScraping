import { test, expect } from "@playwright/test";
import { getMatchLinks } from "../src/scraper/services/matches/index.js";
import { buildMatchListPageHtml } from "./fixtures.js";

// Regression coverage for the mass-scraper's "load more" pagination click,
// which turned out to be blocked by the exact same overlays as the
// day-picker's "next" arrow (see dayPickerDialogs.spec.js / bug #9) —
// mechanically identical bug, same fix shape (clickLoadMoreWithRetries in
// src/scraper/services/matches/index.js, modeled on clickNextDayWithRetries).

const LEAGUE_SEASON_URL = "https://scrape-matchlinks-fixture.test/league/season";
const TYPE = "results";

async function mockMatchListPage(context, html) {
  await context.route(`${LEAGUE_SEASON_URL}/${TYPE}`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
  );
}

test("paginates through every load-more batch when nothing blocks the button", async ({
  context,
}) => {
  const html = buildMatchListPageHtml({
    batches: [
      [{ id: "aaa111" }, { id: "bbb222" }],
      [{ id: "ccc333" }],
    ],
  });
  await mockMatchListPage(context, html);

  const matches = await getMatchLinks(context, LEAGUE_SEASON_URL, TYPE);

  expect(matches).toEqual([
    { id: "aaa111", url: "https://www.flashscore.com/match/football/aaa111/?mid=aaa111" },
    { id: "bbb222", url: "https://www.flashscore.com/match/football/bbb222/?mid=bbb222" },
    { id: "ccc333", url: "https://www.flashscore.com/match/football/ccc333/?mid=ccc333" },
  ]);
});

for (const blockerType of ["age", "cookie", "generic"]) {
  test(`recovers from a "${blockerType}" overlay blocking load-more and still paginates through every batch`, async ({
    context,
  }) => {
    const html = buildMatchListPageHtml({
      batches: [[{ id: "day0a" }], [{ id: "day0b" }]],
      blockerType,
    });
    await mockMatchListPage(context, html);

    const matches = await getMatchLinks(context, LEAGUE_SEASON_URL, TYPE);

    expect(matches.map((m) => m.id)).toEqual(["day0a", "day0b"]);
  });
}

test("gives up with a loud warning (not a silent break) when blocked by an unrecognized overlay", async ({
  context,
}) => {
  // Worst case is genuinely slow here too, for the same reason documented on
  // clickNextDayWithRetries in schedule/index.js: 3 click attempts, each
  // paying the full click timeout plus all three dismiss-attempt timeouts
  // when none of them recognize the overlay.
  test.setTimeout(120_000);

  const html = buildMatchListPageHtml({
    batches: [[{ id: "onlyFirstBatch" }], [{ id: "neverReached" }]],
    blockerType: "unknown",
  });
  await mockMatchListPage(context, html);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  let matches;
  try {
    matches = await getMatchLinks(context, LEAGUE_SEASON_URL, TYPE);
  } finally {
    console.warn = originalWarn;
  }

  // Pagination stopped after the first batch — the important part is that it
  // stopped LOUDLY, with an explanation, rather than silently losing every
  // batch after the first with zero indication anything went wrong.
  expect(matches.map((m) => m.id)).toEqual(["onlyFirstBatch"]);
  expect(warnings.length).toBeGreaterThan(0);
  expect(warnings[0]).toMatch(/não foi possível clicar em "load more"/i);
});
