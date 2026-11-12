// Regenerates oracle/golden/PROVENANCE.json from git history (needs a clone, not an npm install).
//   node scripts/golden-provenance.mjs
//
// Every golden in oracle/golden is the output of pine2py, the sibling implementation resin was first
// built against (its generator is not in this repository). pine2py is NOT ground truth. A golden
// whose file never changed since the 0.1.0 import is "pine2py" as imported. One that a later commit
// rewrote is "edited": the commit subject says which value was corrected and what evidence decided
// it. tests/unit/golden_provenance.test.ts keeps this file in step with the directory.
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();

const files = readdirSync(join(ROOT, "oracle", "golden")).filter((f) => f.endsWith(".json")).sort();
const out = {};
for (const f of files) {
  const log = git("log", "--reverse", "--format=%h\t%ad\t%s", "--date=short", "--", `oracle/golden/${f}`)
    .split("\n").filter(Boolean).map((l) => l.split("\t"));
  const [first, ...later] = log;
  out[f] = later.length === 0
    ? { source: "pine2py", importedIn: first?.[0] ?? null }
    : {
        source: "edited",
        importedIn: first?.[0] ?? null,
        edits: later.map(([commit, date, subject]) => ({ commit, date, subject })),
      };
}
const edited = Object.values(out).filter((v) => v.source === "edited").length;
writeFileSync(
  join(ROOT, "oracle", "golden", "PROVENANCE.json"),
  JSON.stringify({ note: "pine2py output is not ground truth; see scripts/golden-provenance.mjs", total: files.length, edited, goldens: out }, null, 1) + "\n",
);
console.log(`${files.length} goldens, ${edited} edited after import`);
