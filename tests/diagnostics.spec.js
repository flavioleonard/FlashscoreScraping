import { test, expect } from "@playwright/test";
import { openPageAndNavigate, waitForSelectorSafe, diagnoseScrapePage } from "../src/scraper/index.js";
import { buildUnexpectedLayoutHtml, buildRateLimitedPageHtml } from "./fixtures.js";

// Regression coverage for the "good error message" requirement raised
// alongside bug #9: scraping failures (rate-limit, layout drift, or
// anything else) must say WHY instead of vanishing into an empty catch block
// — see waitForSelectorSafe/diagnoseScrapePage in src/scraper/index.js.

const DUMMY_URL = "https://scrape-diagnostics-fixture.test/";

async function mockPage(context, html, status = 200) {
  await context.route(DUMMY_URL, (route) =>
    route.fulfill({ status, contentType: "text/html; charset=utf-8", body: html })
  );
  return openPageAndNavigate(context, DUMMY_URL);
}

test.describe("diagnoseScrapePage", () => {
  test("reports an HTTP error status", async ({ context }) => {
    const page = await mockPage(context, "<html><body>oops</body></html>", 503);
    const diagnosis = await diagnoseScrapePage(page);
    expect(diagnosis).toMatch(/HTTP 503/);
  });

  test("detects a rate-limit/blocking page by its content", async ({ context }) => {
    const page = await mockPage(context, buildRateLimitedPageHtml());
    const diagnosis = await diagnoseScrapePage(page);
    expect(diagnosis).toMatch(/bloqueio|rate-limit/i);
    expect(diagnosis).toContain("Too Many Requests");
  });

  test("falls back to a layout-change diagnosis for an otherwise normal page", async ({ context }) => {
    const page = await mockPage(context, buildUnexpectedLayoutHtml());
    const diagnosis = await diagnoseScrapePage(page);
    expect(diagnosis).toMatch(/mudança de layout/i);
  });
});

test.describe("waitForSelectorSafe", () => {
  test("stays silent when the selector is found", async ({ context }) => {
    const page = await mockPage(context, '<html><body><div class="present">here</div></body></html>');

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      await waitForSelectorSafe(page, [".present"], 1000);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(0);
  });

  test("stays silent when at least one of several alternative selectors is found", async ({
    context,
  }) => {
    const page = await mockPage(context, '<html><body><div class="present">here</div></body></html>');

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      await waitForSelectorSafe(page, [".missing", ".present"], 1000);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(0);
  });

  test("warns with a diagnosis when none of the selectors ever appear", async ({ context }) => {
    const page = await mockPage(context, buildRateLimitedPageHtml());

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      await waitForSelectorSafe(page, [".never-appears"], 1000);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/never-appears/);
    expect(warnings[0]).toMatch(/bloqueio|rate-limit/i);
  });
});
