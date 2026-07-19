import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import pLimit from "p-limit";
import chalk from "chalk";

import { getMatchesForDay } from "./scraper/services/schedule/index.js";
import { getH2HData } from "./scraper/services/h2h/index.js";
import { writeDataToFile } from "./files/handle/index.js";
import { FileTypes } from "./constants/index.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { days: "0-0", competitions: null, concurrency: 5 };

  args.forEach((arg) => {
    if (arg.startsWith("days=")) options.days = arg.split("=")[1];
    if (arg.startsWith("competitions=")) options.competitions = arg.split("=")[1];
    if (arg.startsWith("concurrency=")) options.concurrency = Number(arg.split("=")[1]);
  });

  const [from, to] = options.days.split("-").map(Number);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error(`❌ Invalid days range: "${options.days}" (expected e.g. "0-3")`);
  }

  return { ...options, dayFrom: from, dayTo: to };
}

function loadCompetitions(filePath) {
  if (!filePath) return null;
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

const normalize = (value) =>
  (value ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();

// Loose match against our curated competitions.json: same country, and the
// on-page competition name contains (or is contained by) the slug read as
// words — tolerant of sponsor-name drift (e.g. site drops "Betano").
function isAllowedCompetition(match, competitions) {
  if (!competitions) return true;

  const country = normalize((match.country ?? "").replace(/\s+/g, "-"));
  const competitionText = normalize(match.competition);

  return competitions.some((c) => {
    const cCountry = normalize(c.country.replace(/\s+/g, "-"));
    if (cCountry !== country) return false;

    const slugText = normalize(c.slug.replace(/[-_]/g, " "));
    return competitionText.includes(slugText) || slugText.includes(competitionText);
  });
}

function dateForOffset(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

(async () => {
  let browser;
  let context;

  try {
    const { dayFrom, dayTo, competitions: competitionsPath, concurrency } = parseArgs();
    const competitions = loadCompetitions(competitionsPath);

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();

    for (let offset = dayFrom; offset <= dayTo; offset += 1) {
      console.info(`\n📅 Dia D+${offset}...`);
      const dayMatches = await getMatchesForDay(context, offset);
      const allowed = dayMatches.filter((m) => isAllowedCompetition(m, competitions));

      console.info(
        `   ${dayMatches.length} jogos no dia, ${allowed.length} após filtro de competições`
      );

      const limit = pLimit(concurrency);
      const bundle = {};

      await Promise.all(
        allowed.map((m) =>
          limit(async () => {
            try {
              const h2h = await getH2HData(context, m.url);
              bundle[m.id] = {
                match: { ...h2h.match, competition: m.competition, country: m.country },
                lastMatchesHome: h2h.lastMatchesHome,
                lastMatchesAway: h2h.lastMatchesAway,
                headToHead: h2h.headToHead,
              };
            } catch (error) {
              console.warn(`   ⚠️  Falha em ${m.url}: ${error.message}`);
            }
          })
        )
      );

      const fileName = `h2h/${dateForOffset(offset)}`;
      writeDataToFile(bundle, fileName, FileTypes.JSON);
      console.info(
        `   ${chalk.green("✔")} ${Object.keys(bundle).length} bundles salvos em src/data/${fileName}.json`
      );
    }

    console.info(`\n✅ Varredura H2H concluída.`);
  } catch (error) {
    if (error.message) console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await context?.close();
    await browser?.close();
  }
})();
