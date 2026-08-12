import { test, expect } from "@playwright/test";
import {
  dismissAgeVerificationIfPresent,
  dismissCookieConsentIfPresent,
  dismissGenericDialogIfPresent,
  clickNextDayWithRetries,
} from "../src/scraper/services/schedule/index.js";
import { buildDialogFixtureHtml } from "./fixtures.js";

const NEXT_DAY_SELECTOR = '[data-day-picker-arrow="next"]';

// Regression coverage for bug #9 (see ../CLAUDE.md and the sibling
// bet-predictor repo's CLAUDE.md): the day-picker's "next" arrow can be
// blocked by any of (at least) three unrelated overlays, none of which are
// guaranteed to appear only once — clicking must survive all of them.

test.describe("dismissAgeVerificationIfPresent", () => {
  test("clicks through the age-verification overlay", async ({ page }) => {
    await page.setContent(buildDialogFixtureHtml("age"));
    await expect(page.locator(".blocking-overlay")).toBeVisible();

    await dismissAgeVerificationIfPresent(page);

    await expect(page.locator(".blocking-overlay")).toHaveCount(0);
  });

  test("does nothing (and doesn't throw) when no dialog is present", async ({ page }) => {
    await page.setContent(buildDialogFixtureHtml("none"));
    await expect(dismissAgeVerificationIfPresent(page)).resolves.toBeUndefined();
  });

  test("does not match a different overlay type", async ({ page }) => {
    await page.setContent(buildDialogFixtureHtml("cookie"));
    await dismissAgeVerificationIfPresent(page);
    await expect(page.locator(".blocking-overlay")).toBeVisible();
  });
});

test.describe("dismissCookieConsentIfPresent", () => {
  test("clicks through the OneTrust cookie banner", async ({ page }) => {
    await page.setContent(buildDialogFixtureHtml("cookie"));
    await expect(page.locator(".blocking-overlay")).toBeVisible();

    await dismissCookieConsentIfPresent(page);

    await expect(page.locator(".blocking-overlay")).toHaveCount(0);
  });
});

test.describe("dismissGenericDialogIfPresent", () => {
  test("closes an unrecognized dialog via its generic close button", async ({ page }) => {
    await page.setContent(buildDialogFixtureHtml("generic"));
    await expect(page.locator(".blocking-overlay")).toBeVisible();

    await dismissGenericDialogIfPresent(page);

    await expect(page.locator(".blocking-overlay")).toHaveCount(0);
  });

  test("cannot close the age dialog (it has no generic close button, by design)", async ({ page }) => {
    await page.setContent(buildDialogFixtureHtml("age"));
    await dismissGenericDialogIfPresent(page);
    await expect(page.locator(".blocking-overlay")).toBeVisible();
  });
});

test.describe("clickNextDayWithRetries", () => {
  test("succeeds immediately when nothing blocks the button", async ({ page }) => {
    await page.setContent(buildDialogFixtureHtml("none"));
    const clicked = await clickNextDayWithRetries(page);
    expect(clicked).toBe(true);
  });

  for (const blockerType of ["age", "cookie", "generic"]) {
    test(`recovers from a "${blockerType}" overlay blocking the first attempt`, async ({ page }) => {
      await page.setContent(buildDialogFixtureHtml(blockerType));
      const clicked = await clickNextDayWithRetries(page);
      expect(clicked).toBe(true);
      await expect(page.locator(".blocking-overlay")).toHaveCount(0);
    });
  }

  test("gives up and returns false when blocked by an unrecognized dialog", async ({ page }) => {
    // Worst case here is genuinely slow: 3 click attempts, each paying the
    // full click timeout plus all three dismiss-attempt timeouts in sequence
    // when none of them recognize the overlay (~75s) — see the note on
    // clickNextDayWithRetries about this being a real, known cost of an
    // unrecognized dialog in production too, not just a test artifact.
    test.setTimeout(120_000);
    await page.setContent(buildDialogFixtureHtml("unknown"));

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      const clicked = await clickNextDayWithRetries(page);
      expect(clicked).toBe(false);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/não foi possível avançar o day-picker/i);
  });

  test("returns false without warning when there's simply no next-day button", async ({ page }) => {
    await page.setContent("<!doctype html><html><body>no picker here</body></html>");

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      const clicked = await clickNextDayWithRetries(page);
      expect(clicked).toBe(false);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(0);
  });
});
