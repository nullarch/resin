// Regression guard: `resin build <file>` without -o must print the compiled
// module to stdout and must never write to the input path. The original flag
// fallback (`rest[rest.indexOf('-o') + 1]`) resolved to rest[0] when -o was
// absent, which made the .pine source file itself the output target and
// destroyed it on compile.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO_ROOT, "bin", "resin.mjs");
const SOURCE = `//@version=5\nindicator("cli build")\nplot(close, "c")\n`;

describe("resin build CLI output routing", () => {
  const dir = mkdtempSync(join(tmpdir(), "resin-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("without -o: compiled JS goes to stdout and the source file survives", () => {
    const src = join(dir, "a.pine");
    writeFileSync(src, SOURCE);
    const stdout = execFileSync(process.execPath, [CLI, "build", src], { encoding: "utf-8" });
    expect(stdout).toContain("return function");
    expect(readFileSync(src, "utf-8")).toBe(SOURCE);
  });

  it("with -o: writes exactly the named file, source untouched", () => {
    const src = join(dir, "b.pine");
    const out = join(dir, "b.js");
    writeFileSync(src, SOURCE);
    execFileSync(process.execPath, [CLI, "build", src, "-o", out], { encoding: "utf-8" });
    expect(readFileSync(out, "utf-8")).toContain("return function");
    expect(readFileSync(src, "utf-8")).toBe(SOURCE);
  });
});
