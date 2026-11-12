// One version, said once everywhere. A release is cut from package.json, and the same number is
// repeated in four more places that nothing used to compare:
//
//   package.json "version"  ==  VERSION exported by src/index.ts  ==  the newest released
//   "## [x.y.z]" heading of CHANGELOG.md, and no README claims a version the package has not reached.
//
// Every version a README names is a historical label ("0.3.0 is measured on", "0.2.2 matched 2 of
// 19", the 0.1.0 survey), so a patch release that re-measures nothing may leave them all alone and
// the READMEs are NOT required to name the current version. What is checked is that none names a
// version newer than package.json (a README written for a release that has not been cut), that every
// `@nullarch/resin@x.y.z` install pin is the current version, and that each names some version at all.
//
// The rules are plain functions with negative fixtures below, so the file proves it can fail
// without anyone editing a real document.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/index";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf-8");
const PKG = JSON.parse(read("package.json")) as { name: string; version: string };

const README_FILES = ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"];

type Semver = readonly [number, number, number];

function parseSemver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not a x.y.z version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) {
    const d = x[i]! - y[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

interface ChangelogEntry {
  version: string;
  date: string | null;
}

/** The released `## [x.y.z] - date` headings, newest first as written; `[Unreleased]` is skipped. */
function changelogReleases(changelog: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  for (const line of changelog.split(/\r?\n/)) {
    const m = /^## \[(\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/.exec(line);
    if (m) out.push({ version: m[1]!, date: m[2] ?? null });
  }
  return out;
}

/** Every heading in the file that looks like a version section but did not parse (a typo guard). */
function unparsedChangelogHeadings(changelog: string): string[] {
  return changelog
    .split(/\r?\n/)
    .filter((l) => /^## \[/.test(l) && !/^## \[Unreleased\]\s*$/i.test(l) && !/^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\s*$/.test(l));
}

/** Every x.y.z a document names. */
function versionsNamed(text: string): string[] {
  return [...text.matchAll(/(?<![\d.])(\d+\.\d+\.\d+)(?![\d]|\.\d)/g)].map((m) => m[1]!);
}

function newest(versions: string[]): string | null {
  return versions.length ? versions.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b)) : null;
}

/** Problems with how one README names versions, given the version being released. */
function readmeProblems(text: string, version: string, pkgName: string): string[] {
  const problems: string[] = [];
  const top = newest(versionsNamed(text));
  if (top === null) problems.push("names no version at all (the measured-on-0.x.y lines are gone)");
  else if (compareSemver(top, version) > 0) problems.push(`names ${top}, newer than the version being released (${version})`);
  const pin = new RegExp(`${pkgName.replace(/[/@.]/g, "\\$&")}@(\\d+\\.\\d+\\.\\d+)`, "g");
  for (const m of text.matchAll(pin)) {
    if (m[1] !== version) problems.push(`pins ${pkgName}@${m[1]}, not ${version}`);
  }
  return problems;
}

function changelogProblems(changelog: string, version: string): string[] {
  const problems: string[] = [];
  const releases = changelogReleases(changelog);
  const head = releases[0];
  if (!head) problems.push("no released `## [x.y.z] - date` heading found");
  else if (head.version !== version) problems.push(`first released heading is ${head.version}, not ${version}`);
  for (let i = 1; i < releases.length; i++) {
    if (compareSemver(releases[i - 1]!.version, releases[i]!.version) <= 0) {
      problems.push(`${releases[i - 1]!.version} is listed before ${releases[i]!.version}: versions must descend`);
    }
  }
  for (const r of releases) if (r.date === null) problems.push(`${r.version} has no date`);
  for (const h of unparsedChangelogHeadings(changelog)) problems.push(`malformed version heading: ${h}`);
  const unreleased = changelog.split(/\r?\n/).findIndex((l) => /^## \[Unreleased\]/i.test(l));
  const firstRelease = changelog.split(/\r?\n/).findIndex((l) => /^## \[\d/.test(l));
  if (unreleased > firstRelease && firstRelease >= 0) problems.push("[Unreleased] must come before the released versions");
  return problems;
}

describe("version consistency across package.json, src/index.ts, CHANGELOG.md and the READMEs", () => {
  it("package.json is a plain x.y.z version", () => {
    expect(parseSemver(PKG.version), `package.json version ${PKG.version}`).not.toBeNull();
  });

  it("VERSION exported by src/index.ts equals package.json", () => {
    expect(VERSION).toBe(PKG.version);
  });

  it("CHANGELOG.md: the first released heading is this version, versions descend, every one is dated", () => {
    expect(changelogProblems(read("CHANGELOG.md"), PKG.version)).toEqual([]);
  });

  for (const file of README_FILES) {
    it(`${file} names no version newer than this one, and pins no other`, () => {
      expect(readmeProblems(read(file), PKG.version, PKG.name)).toEqual([]);
    });
  }
});

describe("the rules themselves fail when they should (fixtures, not real files)", () => {
  const CHANGELOG = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- something pending",
    "",
    "## [0.3.0] - 2026-09-28",
    "",
    "## [0.2.2] - 2026-08-01",
    "",
  ].join("\n");

  it("skips a leading [Unreleased] and reads the first released heading", () => {
    expect(changelogReleases(CHANGELOG)[0]).toEqual({ version: "0.3.0", date: "2026-09-28" });
    expect(changelogProblems(CHANGELOG, "0.3.0")).toEqual([]);
  });

  it("flags a package bumped past the changelog", () => {
    expect(changelogProblems(CHANGELOG, "0.3.1")).toEqual(["first released heading is 0.3.0, not 0.3.1"]);
  });

  it("flags a changelog written for a release the package has not reached", () => {
    const ahead = CHANGELOG.replace("## [Unreleased]", "## [Unreleased]\n\n## [0.4.0] - 2026-10-30");
    expect(changelogProblems(ahead, "0.3.0")).toContain("first released heading is 0.4.0, not 0.3.0");
  });

  it("flags out-of-order, undated and malformed headings, and a changelog with no release", () => {
    expect(changelogProblems("## [0.2.0] - 2026-01-01\n## [0.3.0] - 2026-02-01\n", "0.2.0").join("|")).toMatch(/must descend/);
    expect(changelogProblems("## [0.3.0]\n", "0.3.0")).toContain("0.3.0 has no date");
    expect(changelogProblems("## [0.3.0] - 2026-9-1\n", "0.3.0").join("|")).toMatch(/malformed version heading: ## \[0\.3\.0\] - 2026-9-1/);
    expect(changelogProblems("## [Unreleased]\n", "0.3.0")).toEqual(["no released `## [x.y.z] - date` heading found"]);
  });

  const README = "Measured on 0.3.0; 0.2.2 matched 2 of 19, the 0.1.0 survey is historical.\nnpm i @nullarch/resin@0.3.0\n";

  it("accepts a README whose newest version is this one, older ones being history", () => {
    expect(readmeProblems(README, "0.3.0", "@nullarch/resin")).toEqual([]);
  });

  it("accepts a README after a patch release that re-measured nothing (its versions are history)", () => {
    expect(readmeProblems("Measured on 0.3.0; 0.2.2 matched 2 of 19.\n", "0.3.1", "@nullarch/resin")).toEqual([]);
  });

  it("flags an install pin left behind by a bump", () => {
    expect(readmeProblems(README, "0.3.1", "@nullarch/resin")).toEqual(["pins @nullarch/resin@0.3.0, not 0.3.1"]);
  });

  it("flags a README ahead of the package", () => {
    expect(readmeProblems(`${README}New in 0.4.0.\n`, "0.3.0", "@nullarch/resin").join("|")).toMatch(/names 0\.4\.0, newer/);
  });

  it("flags a stale install pin even when a newer version is named elsewhere", () => {
    expect(readmeProblems("Measured on 0.3.0.\nnpm i @nullarch/resin@0.2.2\n", "0.3.0", "@nullarch/resin")).toEqual([
      "pins @nullarch/resin@0.2.2, not 0.3.0",
    ]);
  });

  it("flags a README that names no version", () => {
    expect(readmeProblems("no numbers here", "0.3.0", "@nullarch/resin")[0]).toMatch(/names no version/);
  });

  it("compares versions numerically, not as strings", () => {
    expect(newest(["0.9.0", "0.10.0", "0.2.2"])).toBe("0.10.0");
    expect(versionsNamed("v0.3.0, 1.2.3.4 and 10.20.30")).toEqual(["0.3.0", "10.20.30"]);
  });
});
