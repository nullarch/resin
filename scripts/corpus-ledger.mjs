// Summarises corpus/diff/status.json, the per-hash ledger tests/unit/corpus_diff.test.ts gates on.
//   node scripts/corpus-ledger.mjs --summary          counts by status
//   node scripts/corpus-ledger.mjs --list mismatch    the hashes with that status
// "matched_vacuous" is a match in which no compared channel ever varies (all NaN or constant): it
// agrees with the golden but proves nothing. Only "matched" counts as evidence.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ledger = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "diff", "status.json"), "utf-8"));
const [flag, arg] = process.argv.slice(2);
if (flag === "--list" && arg) {
  for (const [hash, status] of Object.entries(ledger)) if (status === arg) console.log(hash);
} else {
  const counts = {};
  for (const status of Object.values(ledger)) counts[status] = (counts[status] ?? 0) + 1;
  console.log(`${Object.keys(ledger).length} scripts`);
  for (const [status, n] of Object.entries(counts).sort()) console.log(`  ${status.padEnd(18)} ${n}`);
}
