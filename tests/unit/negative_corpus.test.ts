// The negative corpus: Pine that must be refused, and the valid scripts right next to it.
//
// The rest of the suite feeds resin valid scripts, so nothing else measures a false accept (invalid
// Pine that compiles). tests/negative/ holds:
//   cases/*.pine       scripts with one defect each; transpile() must return { ok: false } with a
//                      message that matches manifest.json, and never an `internal error` (a crash is a
//                      bug, not a refusal)
//   near_miss/*.pine   the same shapes with the defect removed, plus awkward but valid sources (CRLF,
//                      BOM, no-break spaces, tabs, strings and comments full of stray characters);
//                      transpile() must return { ok: true }, so new strictness cannot over-refuse
//   manifest.json      one entry per file: { dir, match (cases only), why, source? }
//   false_accepts.json scripts that are invalid under any reading of Pine and that resin nevertheless
//                      accepts (or crashes on). Each one is an `it.fails` below: when resin is fixed
//                      the test starts to pass, vitest reports it as failed, and the entry moves into
//                      cases/ with a regex.
//
// A file that would hold an invisible character (NUL, other control characters, a BOM, no-break and
// other Unicode spaces, zero-width characters, a CR) is stored with those shown as <U+XXXX> / <CR>,
// and the manifest's `source` field holds the real text with JSON escapes. The test runs `source`
// and checks that the file is its rendering, so the bytes that matter never depend on how a checkout
// or an editor treated the file.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { transpile } from "../../src/index";

const ROOT = fileURLToPath(new URL("../negative/", import.meta.url));

interface ManifestEntry {
  dir: "cases" | "near_miss";
  match?: string;
  why: string;
  source?: string;
}
interface FalseAccept {
  id: string;
  // grammar: syntax, reserved words, malformed literals; undeclared-type: a type name declared
  // nowhere; static-type: a value of the wrong type; builtin-arity: an argument count taken from the
  // Pine reference, not from this repo (see `evidence`).
  category: "grammar" | "undeclared-type" | "static-type" | "builtin-arity";
  source: string;
  why: string;
  // accepted: transpile() returns ok:true. internal: it returns `internal error:` (a crash caught by
  // the last stage), which is not a refusal either.
  kind: "accepted" | "internal";
  evidence?: string;
}

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")) as Record<string, ManifestEntry>;
const falseAccepts = JSON.parse(readFileSync(join(ROOT, "false_accepts.json"), "utf8")) as FalseAccept[];

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/u;

// What a file holds for a source with invisible characters: each one spelled out, a CR as <CR>.
function render(source: string): string {
  let out = "";
  for (const ch of source) {
    if (ch === "\n" || ch === " " || ch === "\t") out += ch;
    else if (ch === "\r") out += "<CR>";
    else if (INVISIBLE.test(ch)) out += `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`;
    else out += ch;
  }
  return out;
}

function listFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".pine"))
    .map((f) => f.slice(0, -".pine".length))
    .sort();
}

function readFile(dir: string, id: string): string {
  return readFileSync(join(ROOT, dir, `${id}.pine`), "utf8");
}

// The script an entry stands for.
function sourceOf(id: string): string {
  const entry = manifest[id]!;
  return entry.source ?? readFile(entry.dir, id);
}

const caseIds = Object.keys(manifest).filter((id) => manifest[id]!.dir === "cases").sort();
const nearMissIds = Object.keys(manifest).filter((id) => manifest[id]!.dir === "near_miss").sort();

describe("negative corpus - the files and the manifest agree", () => {
  it("lists every file in cases/ and near_miss/ in the manifest, and every manifest entry has its file", () => {
    for (const dir of ["cases", "near_miss"] as const) {
      const onDisk = listFiles(dir);
      const listed = Object.keys(manifest)
        .filter((id) => manifest[id]!.dir === dir)
        .sort();
      expect(onDisk, `${dir}/ against manifest.json`).toEqual(listed);
    }
    for (const id of Object.keys(manifest)) {
      expect(["cases", "near_miss"], id).toContain(manifest[id]!.dir);
    }
  });

  it("has no id that is used in both directories or in false_accepts.json", () => {
    const ids = [...Object.keys(manifest), ...falseAccepts.map((f) => f.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("holds enough scripts to mean something", () => {
    expect(caseIds.length).toBeGreaterThanOrEqual(100);
    expect(nearMissIds.length).toBeGreaterThanOrEqual(40);
  });

  it("groups every case under one of the five id prefixes, and gives each entry a reason", () => {
    for (const id of caseIds) expect(id, id).toMatch(/^(lex|syntax|name|call|type)_[a-z0-9_]+$/);
    for (const id of nearMissIds) expect(id, id).toMatch(/^(lex|syntax|name|call|type)_[a-z0-9_]+_ok$/);
    for (const id of Object.keys(manifest)) expect(manifest[id]!.why.trim().length, id).toBeGreaterThan(10);
    for (const id of caseIds) {
      const m = manifest[id]!.match;
      expect(typeof m, `${id} needs a match`).toBe("string");
      expect(() => new RegExp(m!), `${id} match is a valid regex`).not.toThrow();
    }
    for (const id of nearMissIds) expect(manifest[id]!.match, `${id} is a near-miss, it has no error to match`).toBeUndefined();
  });

  it("stores invisible characters only as the manifest's `source`, and keeps the file the rendering of it", () => {
    for (const id of Object.keys(manifest)) {
      const entry = manifest[id]!;
      const file = readFile(entry.dir, id);
      if (entry.source !== undefined) {
        expect(render(entry.source), `${id}: the file must be the rendering of source`).toBe(file);
        expect(render(entry.source), `${id}: source holds no invisible character, drop the field`).not.toBe(entry.source);
      } else {
        for (const ch of file) {
          if (ch === "\n" || ch === " " || ch === "\t") continue;
          expect(INVISIBLE.test(ch), `${id}: the file holds U+${ch.codePointAt(0)!.toString(16).toUpperCase()}; give the entry a \`source\``).toBe(false);
        }
      }
    }
  });
});

describe("negative corpus - every case is refused, with the right message and not by a crash", () => {
  for (const id of caseIds) {
    it(id, () => {
      const result = transpile(sourceOf(id));
      expect(result.ok, `${id} was accepted: ${manifest[id]!.why}`).toBe(false);
      if (result.ok) return;
      expect(result.internal, `${id} crashed resin instead of being refused: ${result.errors[0]}`).toBeUndefined();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0], id).toMatch(new RegExp(manifest[id]!.match!));
    });
  }
});

describe("negative corpus - every near-miss still compiles", () => {
  for (const id of nearMissIds) {
    it(id, () => {
      const result = transpile(sourceOf(id));
      if (!result.ok) expect.fail(`${id} was refused (${manifest[id]!.why}): ${result.errors[0]}`);
      expect(result.ok).toBe(true);
    });
  }
});

// Each of these is Pine that is invalid under any reading of the language and that resin does not
// refuse. `it.fails` keeps the gap visible without breaking the suite: it passes while resin accepts
// the script (or crashes on it), and fails the day resin refuses it - then the entry belongs in
// cases/ with a regex, and the line in false_accepts.json goes.
describe("negative corpus - known false accepts (it.fails: each one is a bug in resin)", () => {
  it("keeps one entry per script, with the way it goes wrong and the evidence where the repo has none", () => {
    expect(falseAccepts.length).toBeGreaterThan(0);
    for (const f of falseAccepts) {
      expect(["accepted", "internal"], f.id).toContain(f.kind);
      expect(["grammar", "undeclared-type", "static-type", "builtin-arity"], f.id).toContain(f.category);
      expect(f.why.trim().length, f.id).toBeGreaterThan(10);
      if (f.category === "builtin-arity") expect(f.evidence, `${f.id} must say where its signature comes from`).toBeTruthy();
    }
  });

  for (const f of falseAccepts) {
    // The title carries what resin wrongly does: `why` says exactly which invalid Pine it takes.
    it.fails(`${f.id} [${f.category}, ${f.kind === "accepted" ? "ok:true" : "internal error"}] ${f.why}`, () => {
      const result = transpile(f.source);
      expect(result.ok, `${f.id}: ${f.why}`).toBe(false);
      if (result.ok) return;
      expect(result.internal, `${f.id} crashed resin instead of being refused: ${result.errors[0]}`).toBeUndefined();
    });
  }
});
