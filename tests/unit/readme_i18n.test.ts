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
  "95.1%", // corpus compile rate
  "12,424", // snapshot
  "1,085", // TradingView rejects them too
  "719", // unresolvable private imports
  "10,618", // denominator
  "10,100", // compiles
  "9,870", // tests
  "263", // oracle scripts
  "1e-9", // oracle tolerance
  "22.18", // minimum Node
  "378", // untranslated compiler messages
  "14,000", // untranslated comment lines
];

// Bare numbers that need a word boundary so they don't match inside a larger figure.
const BOUNDED_FIGURES = [68 /* ta.* functions */, 800 /* agent iterations */];

const SHARED_LINKS = ["API.md", "LICENSE", "docs/logo.svg", "docs/hero.svg"];

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
