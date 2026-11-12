// Translated READMEs go stale silently: someone re-measures a number, edits
// README.md, and the other three keep claiming yesterday's figure. Nothing
// fails, and the project's whole argument is that its numbers are measured.
//
// So the load-bearing figures are asserted to appear in every language, and the
// language switcher is asserted to be complete in each file. A translation may
// reword anything it likes; it may not disagree about a number or drop a link.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LANGS = [
  { file: "README.md", label: "English" },
  { file: "README.zh-CN.md", label: "简体中文" },
  { file: "README.ja.md", label: "日本語" },
  { file: "README.ko.md", label: "한국어" },
];

// Every claim in the README that came from a measurement rather than prose.
const FIGURES = [
  // Verification (0.3.0, resin-harness): TradingView's own exports.
  "16,259", // strategy trade and statistic records matched
  "0fd57d7", // PyneCore commit the exports come from
  // The certified reference engine and the fuzz corpus against it.
  "380", // of 402 published strategies, trade for trade (PyneCore's certification)
  "402",
  "99.64%", // of bars bit for bit (PyneCore's certification)
  "61.8M",
  "5,000", // generated scenarios
  "4,937", // of them matching
  "3,600", // strategy scenarios, all matching
  "737", // of 800 indicator scenarios
  "1e-9", // fuzz and differential tolerance
  // The real-world corpus (acceptance only).
  "3,904", // v5/v6 files
  "543", // repositories
  "413", // scraped pages left out
  "313", // judged invalid
  "199", // library-importing
  "2,979", // plain scripts
  "2,970", // transpile
  "2,964", // run
  "99.7%", // transpile rate
  "99.5%", // run rate
  // The 0.1 survey, kept as a historical measurement.
  "95.1%", // corpus compile rate
  "12,424", // snapshot
  "1,085", // TradingView rejects them too
  "719", // unresolvable private imports
  "10,618", // denominator
  "10,100", // compiles
  // The test suites.
  "10,431", // tests
  "9,883", // tests that hid the first loop's mistakes
  "263", // oracle/ regression cases
  // Quick start output.
  "57.66239695541216",
  "54.05646249096931",
  // Everything else.
  "22.18", // minimum Node
  "121", // commits of the correctness loop since 0.2.2
  "365", // compiler messages (translated to English)
  "12,400", // untranslated Korean comment lines
];

// Bare numbers that need a word boundary so they don't match inside a larger figure.
const BOUNDED_FIGURES = [
  68 /* ta.* functions */,
  800 /* agent iterations; indicator scenarios */,
  93 /* TradingView export scenarios matched */,
  95 /* TradingView export scenarios */,
  117 /* of 118 probes */,
  118,
];

const SHARED_LINKS = ["API.md", "CHANGELOG.md", "LICENSE", "docs/logo.svg", "docs/hero.svg"];

const read = (file: string) => readFileSync(join(REPO_ROOT, file), "utf-8");

describe("README translations stay in sync", () => {
  it.each(LANGS)("$file exists", ({ file }) => {
    expect(existsSync(join(REPO_ROOT, file))).toBe(true);
  });

  it.each(LANGS)("$file links to every other language and marks itself", ({ file, label }) => {
    const text = read(file);
    expect(text, `${file} does not mark ${label} as the current language`).toContain(
      `<strong>${label}</strong>`,
    );
    for (const other of LANGS.filter((l) => l.file !== file)) {
      expect(text, `${file} is missing the ${other.label} link`).toContain(
        `<a href="${other.file}">${other.label}</a>`,
      );
    }
  });

  it.each(LANGS)("$file carries every measured figure", ({ file }) => {
    const text = read(file);
    for (const figure of FIGURES) {
      expect(text, `${file} is missing the figure ${figure}`).toContain(figure);
    }
    for (const n of BOUNDED_FIGURES) {
      expect(new RegExp(`\\b${n}\\b`).test(text), `${file} is missing the figure ${n}`).toBe(true);
    }
  });

  it.each(LANGS)("$file keeps the shared relative links", ({ file }) => {
    const text = read(file);
    for (const link of SHARED_LINKS) {
      expect(text, `${file} is missing a link to ${link}`).toContain(link);
    }
  });

  it("the quick-start anchor resolves in every file", () => {
    for (const { file } of LANGS) {
      const text = read(file);
      expect(text).toContain('href="#quick-start"');
      // English derives the anchor from its own heading; the translations declare it.
      const hasAnchor = file === "README.md"
        ? /^##\s+Quick start\s*$/m.test(text)
        : text.includes('<a id="quick-start"></a>');
      expect(hasAnchor, `${file} has no target for #quick-start`).toBe(true);
    }
  });
});
