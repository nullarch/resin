import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index";

describe("scaffold smoke", () => {
  it("package loads", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
