// Every oracle golden is pine2py output (not ground truth) and some were corrected by hand. This
// test keeps oracle/golden/PROVENANCE.json — which file is raw, which was edited and by what
// evidence — in step with the directory, so a golden cannot be added or rewritten without saying so.
// Regenerate with `node scripts/golden-provenance.mjs` (needs the git history).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "oracle", "golden");
const provenance = JSON.parse(readFileSync(join(GOLDEN_DIR, "PROVENANCE.json"), "utf-8")) as {
  total: number;
  edited: number;
  goldens: Record<string, { source: string; importedIn: string | null; edits?: { commit: string; subject: string }[] }>;
};
const onDisk = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json") && f !== "PROVENANCE.json").sort();

describe("oracle golden provenance", () => {
  it("lists exactly the goldens on disk", () => {
    expect(Object.keys(provenance.goldens).sort()).toEqual(onDisk);
    expect(provenance.total).toBe(onDisk.length);
  });

  it("every entry says where it came from, and every edit names its commit", () => {
    let edited = 0;
    for (const [file, p] of Object.entries(provenance.goldens)) {
      expect(["pine2py", "edited"], file).toContain(p.source);
      expect(p.importedIn, `${file} has no import commit`).toBeTruthy();
      if (p.source === "edited") {
        edited++;
        expect(p.edits?.length, `${file} is edited but lists no edit`).toBeGreaterThan(0);
        for (const e of p.edits!) expect(e.subject.length, `${file}: edit ${e.commit} has no subject`).toBeGreaterThan(0);
      } else {
        expect(p.edits, `${file} is raw but lists edits`).toBeUndefined();
      }
    }
    expect(edited).toBe(provenance.edited);
  });
});
