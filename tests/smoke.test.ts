import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/index";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
) as { version: string };

describe("scaffold smoke", () => {
  it("package loads", () => {
    expect(typeof VERSION).toBe("string");
  });

  // Pinning the literal here meant the exported version and package.json could
  // drift apart and the suite would still pass. Compare them instead.
  it("the exported version matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
