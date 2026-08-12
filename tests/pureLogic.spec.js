import { test, expect } from "@playwright/test";
import { normalize, isAllowedCompetition, dateForOffset, parseArgs } from "../src/scan-h2h.js";
import { normalizeH2HDate, buildH2HUrl } from "../src/scraper/services/h2h/index.js";
import { buildStatsUrl } from "../src/scraper/services/matches/index.js";
import { CANCEL_MESSAGE, throwCancelled } from "../src/constants/index.js";

test.describe("scan-h2h.js pure helpers", () => {
  test.describe("normalize", () => {
    test("lowercases, strips punctuation, and trims", () => {
      expect(normalize("  Série A!  ")).toBe("serie a");
    });

    test("folds accented letters onto their unaccented base instead of dropping them", () => {
      // Regression coverage: this used to normalize to "brasileiro" (the "ã"
      // silently disappeared), one letter short of the unaccented
      // competitions.json slug text ("brasileirao") it's meant to match against.
      expect(normalize("Brasileirão")).toBe("brasileirao");
    });

    test("handles null/undefined without throwing", () => {
      expect(normalize(null)).toBe("");
      expect(normalize(undefined)).toBe("");
    });
  });

  test.describe("isAllowedCompetition", () => {
    const competitions = [
      { country: "Brazil", slug: "brasileirao-serie-a" },
      { country: "England", slug: "premier-league" },
    ];

    test("allows everything when no allow-list is given", () => {
      expect(isAllowedCompetition({ country: "Anywhere", competition: "Anything" }, null)).toBe(true);
    });

    test("matches on country + competition text, tolerant of sponsor-name drift", () => {
      expect(
        isAllowedCompetition({ country: "England", competition: "Premier League - Betano" }, competitions)
      ).toBe(true);
    });

    test("matches an accented competition name against its unaccented slug", () => {
      expect(
        isAllowedCompetition(
          { country: "Brazil", competition: "Brasileirão Série A - Betano" },
          competitions
        )
      ).toBe(true);
    });

    test("rejects a competition from an unlisted country", () => {
      expect(
        isAllowedCompetition({ country: "Spain", competition: "LaLiga" }, competitions)
      ).toBe(false);
    });

    test("rejects a different competition from an allowed country", () => {
      expect(
        isAllowedCompetition({ country: "Brazil", competition: "Copa do Brasil" }, competitions)
      ).toBe(false);
    });
  });

  test.describe("dateForOffset", () => {
    test("offset 0 is today, in YYYY-MM-DD form", () => {
      const today = new Date().toISOString().slice(0, 10);
      expect(dateForOffset(0)).toBe(today);
    });

    test("each offset is exactly one day after the previous one", () => {
      const day0 = new Date(dateForOffset(0));
      const day3 = new Date(dateForOffset(3));
      const diffDays = Math.round((day3 - day0) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBe(3);
    });
  });

  test.describe("parseArgs", () => {
    const originalArgv = process.argv;
    test.afterEach(() => {
      process.argv = originalArgv;
    });

    test("defaults to days=0-0 and concurrency=5 with no arguments", () => {
      process.argv = ["node", "scan-h2h.js"];
      expect(parseArgs()).toMatchObject({ dayFrom: 0, dayTo: 0, concurrency: 5, competitions: null });
    });

    test("parses days/competitions/concurrency overrides", () => {
      process.argv = ["node", "scan-h2h.js", "days=1-3", "competitions=./x.json", "concurrency=8"];
      expect(parseArgs()).toMatchObject({
        dayFrom: 1,
        dayTo: 3,
        concurrency: 8,
        competitions: "./x.json",
      });
    });

    test("rejects a malformed days range", () => {
      process.argv = ["node", "scan-h2h.js", "days=oops"];
      expect(() => parseArgs()).toThrow(/Invalid days range/);
    });
  });
});

test.describe("h2h/index.js pure helpers", () => {
  test.describe("normalizeH2HDate", () => {
    test("expands a 2-digit year H2H date into the scraper's full date format", () => {
      expect(normalizeH2HDate("12.08.26")).toBe("12.08.2026 00:00");
    });

    test("passes through anything that doesn't match DD.MM.YY", () => {
      expect(normalizeH2HDate("12.08.2026 15:00")).toBe("12.08.2026 15:00");
    });

    test("handles missing input without throwing", () => {
      expect(normalizeH2HDate(undefined)).toBe("");
      expect(normalizeH2HDate(null)).toBe("");
    });
  });

  test.describe("buildH2HUrl", () => {
    test("rewrites a match URL to its H2H overall tab, preserving the mid param", () => {
      expect(buildH2HUrl("https://www.flashscore.com/match/football/aaa111/?mid=aaa111")).toBe(
        "https://www.flashscore.com/match/football/aaa111/h2h/overall/?mid=aaa111"
      );
    });

    test("returns null for a null/missing match URL", () => {
      expect(buildH2HUrl(null)).toBeNull();
      expect(buildH2HUrl(undefined)).toBeNull();
    });

    test("returns null (instead of a literal 'mid=null') when the URL has no mid param", () => {
      expect(buildH2HUrl("https://www.flashscore.com/match/football/aaa111/")).toBeNull();
    });
  });

  test.describe("buildStatsUrl", () => {
    test("rewrites a match URL to its stats tab, preserving the mid param", () => {
      expect(buildStatsUrl("https://www.flashscore.com/match/football/aaa111/?mid=aaa111")).toBe(
        "https://www.flashscore.com/match/football/aaa111/summary/stats/?mid=aaa111"
      );
    });

    test("returns null for a null/missing match URL", () => {
      expect(buildStatsUrl(null)).toBeNull();
      expect(buildStatsUrl(undefined)).toBeNull();
    });

    test("returns null (instead of a literal 'mid=null') when the URL has no mid param", () => {
      expect(buildStatsUrl("https://www.flashscore.com/match/football/aaa111/")).toBeNull();
    });
  });
});

test.describe("CLI prompt cancel throw (bug: bare `throw Error;` had no .message)", () => {
  // These four prompt modules (countries/leagues/season/fileType) are
  // interactive inquirer prompts, not practical to drive end-to-end in a
  // test — but their "what to throw on Cancel" logic has been extracted into
  // this one shared, directly-testable function, so the actual fix (a real
  // Error instance with a real message, not the bare `Error` constructor) is
  // verified here rather than just documented. See constants/index.js for
  // why this mattered: src/index.js's catch only logged `error.message`,
  // which is falsy for a bare `throw Error;`, so cancelling silently killed
  // the whole CLI with zero output.
  test("throws a real Error instance with a non-empty message", () => {
    expect(() => throwCancelled()).toThrow(Error);
    expect(() => throwCancelled()).toThrow(CANCEL_MESSAGE);
  });

  test("the thrown error's message is truthy (this is what src/index.js's catch checks)", () => {
    try {
      throwCancelled();
    } catch (error) {
      expect(error.message).toBeTruthy();
      expect(error.message).toBe(CANCEL_MESSAGE);
    }
  });
});
