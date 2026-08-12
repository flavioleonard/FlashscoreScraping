export const BASE_URL = "https://www.flashscore.com";
export const OUTPUT_PATH = "./src/data";
export const TIMEOUT = 8000;

// Shared by every interactive CLI prompt's "Cancel" branch (countries,
// leagues, season, fileType). They used to each do a bare `throw Error;` —
// throwing the Error *constructor function itself*, not an instance — so the
// thrown value had no `.message`. src/index.js's outer catch only logs when
// `error.message` is truthy, which is falsy for a bare function, so
// cancelling ANY prompt silently exited the whole CLI with zero console
// output (exitCode 1, no explanation) — looked like the program just died.
// Centralizing the actual throw here (instead of `throw Error(CANCEL_MESSAGE)`
// repeated at each of the four call sites) makes the fixed behavior directly
// unit-testable without having to drive an interactive inquirer prompt.
export const CANCEL_MESSAGE = "❌ No option selected. Exiting...";

export const throwCancelled = () => {
  throw Error(CANCEL_MESSAGE);
};
export const FileTypes = Object.freeze({
  JSON: {
    label: "JSON (Padrão)",
    argument: "json",
    extension: ".json",
  },
  JSON_ARRAY: {
    label: "JSON Array (Lista)",
    argument: "json-array",
    extension: ".array.json",
  },
  CSV: {
    label: "Arquivo CSV",
    argument: "csv",
    extension: ".csv",
  },
});
