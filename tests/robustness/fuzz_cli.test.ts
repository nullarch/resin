// scripts/fuzz.mjs itself: it runs, it reports, and its own hang/abort detection works. The hangs
// the engine still has (KD11 in tests/robustness/README.md) cannot be reproduced in-process, so
// their `it.fails` run through the script's child process with a short timeout.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { KNOWN_DEFECTS, PINE_HEADER } from "./fuzzlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "fuzz.mjs");
const work = mkdtempSync(join(tmpdir(), "resin-fuzz-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Done {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Done> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", SCRIPT, ...args], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`scripts/fuzz.mjs did not finish: ${args.join(" ")}`));
    }, 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function check(name: string, body: string, timeoutSec: number): Promise<{ kind: string; status: number | null }> {
  const file = join(work, `${name}.pine`);
  writeFileSync(file, PINE_HEADER + body + "\n");
  const done = await cli(["--check", file, "--timeout", String(timeoutSec)]);
  const m = /"kind": "(\w+)"/.exec(done.stdout);
  if (m === null) throw new Error(`no outcome from --check: ${done.stdout}${done.stderr}`);
  return { kind: m[1]!, status: done.status };
}

describe.concurrent("scripts/fuzz.mjs", () => {
  it("runs a small seeded fuzz, counts every mutant once and exits 0 when only known defects fail", async () => {
    const out = join(work, "small");
    const done = await cli(["--count", "40", "--seed", "3", "--jobs", "1", "--no-minimize", "--known-ok", "--out", out]);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).toMatch(/unique mutants/);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) as { unique: number; duplicates: number; outcomes: Record<string, number> };
    expect(Object.values(summary.outcomes).reduce((a, b) => a + b, 0)).toBe(summary.unique);
    expect(summary.unique + summary.duplicates).toBe(40);
    expect(summary.outcomes.rejected).toBeGreaterThan(0);
  });

  it("detects a child that hangs or aborts, survives it, and answers the next script", async () => {
    const done = await cli(["--selftest", "--timeout", "0.4"]);
    expect(done.stdout).toMatch(/ok\s+hang\s+F_hang/);
    expect(done.stdout).toMatch(/ok\s+abort\s+F_crash/);
    expect(done.stdout).toMatch(/ok\s+normal after abort\s+ran/);
    expect(done.stdout).not.toMatch(/FAIL/);
    expect(done.status, done.stdout + done.stderr).toBe(0);
  });

  // KD11: the engine hangs. They are `it.fails` because the day they stop hanging, this
  // should go red so the known-defect entry gets deleted.
  for (const kd of KNOWN_DEFECTS.filter((k) => k.inProcessUnsafe)) {
    it.fails(`${kd.id}: ${kd.repros[0]!.slice(0, 60)} does not hang`, async () => {
      const r = await check(kd.id, kd.repros[0]!, 0.6);
      expect(r.kind).not.toBe("F_hang");
    });
  }
});
