// `import` links a library's source into the script (src/transpiler/passes/libraries.ts). The anchor for
// the numbers: a script that imports a library must behave exactly like the same script with the
// library's functions pasted in by hand, and a stateful library function must keep one state per call.
import { describe, expect, it } from "vitest";
import { run, transpile } from "../../src/index";
import type { RunResult, TranspileOk } from "../../src/index";

const BARS = 240;
const close = Array.from({ length: BARS }, (_, i) => 100 + 10 * Math.sin(i / 7) + 3 * Math.cos(i / 2.3) + i * 0.05);
const data = {
  open: close.map((c, i) => (i === 0 ? c : close[i - 1]!)),
  high: close.map((c) => c + 1.5),
  low: close.map((c) => c - 1.25),
  close,
  volume: close.map((_, i) => 1000 + (i % 13) * 10),
  time: close.map((_, i) => 1_600_000_000_000 + i * 86_400_000),
};

function compile(source: string, libraries?: Record<string, string>): TranspileOk {
  const r = transpile(source, libraries === undefined ? {} : { libraries });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r;
}
function plots(result: RunResult): Record<string, (number | null)[]> {
  return Object.fromEntries(result.plots.map((p) => [p.title, Array.from(p.values as ArrayLike<number>, (v) => (Number.isNaN(v) ? null : v))]));
}
function errorsOf(source: string, libraries?: Record<string, string>): string[] {
  const r = transpile(source, libraries === undefined ? {} : { libraries });
  if (r.ok) throw new Error("expected a refusal");
  return r.errors;
}

const SMOOTH = `//@version=5
library("Smooth", true)
const float SCALE = 2.0
export type Band
    float upper
    float lower
export enum Side
    up
    down
hidden(float x) =>
    x * SCALE
export smooth(series float src, simple int n = 5) =>
    ta.ema(src, n)
export stepped(series float src) =>
    var float total = 0.0
    total += src
    hidden(total)
export band(series float src, simple float w) =>
    Band.new(src + w, src - w)
export width(Band b) =>
    b.upper - b.lower
export method widen(Band b, float d) =>
    Band.new(b.upper + d, b.lower - d)
export sideOf(series float a, series float b) =>
    a > b ? Side.up : Side.down
yhat = smooth(close, 8)
plot(yhat, title = "library demo")
`;
const LIBS = { "me/Smooth/1": SMOOTH };

describe("a linked library behaves like the same code pasted into the script", () => {
  it("functions, a default argument, a private helper and a const", () => {
    const linked = `//@version=5
indicator("x")
import me/Smooth/1 as s
plot(s.smooth(close, 3), "a")
plot(s.smooth(close), "b")
plot(s.stepped(close), "c")
`;
    const pasted = `//@version=5
indicator("x")
const float SCALE = 2.0
hidden(float x) =>
    x * SCALE
smooth(series float src, simple int n = 5) =>
    ta.ema(src, n)
stepped(series float src) =>
    var float total = 0.0
    total += src
    hidden(total)
plot(smooth(close, 3), "a")
plot(smooth(close), "b")
plot(stepped(close), "c")
`;
    const a = plots(run(compile(linked, LIBS), data));
    expect(a).toEqual(plots(run(compile(pasted), data)));
    expect(a.a!.some((v) => v !== null)).toBe(true);
  });

  it("each call of a stateful library function keeps its own state", () => {
    const r = plots(run(compile(`//@version=5
indicator("x")
import me/Smooth/1 as s
plot(s.stepped(close), "one")
plot(s.stepped(close * 2), "two")
`, LIBS), data));
    let total = 0;
    close.forEach((c, i) => {
      total += c;
      expect(r.one![i]).toBeCloseTo(total * 2, 6);
      expect(r.two![i]).toBeCloseTo(total * 4, 6);
    });
  });

  it("types, methods and enums cross the import, and the hand calculation agrees", () => {
    const r = plots(run(compile(`//@version=5
indicator("x")
import me/Smooth/1 as s
s.Band b = s.band(close, 2.0)
plot(s.width(b), "width")
plot(s.width(b.widen(1.5)), "sugar")
plot(s.width(s.widen(b, 0.5)), "function form")
plot(s.sideOf(close, open) == s.Side.up ? 1 : 0, "side")
var array<s.Band> kept = array.new<s.Band>()
kept.unshift(b)
plot(kept.size(), "kept")
plot(kept.first().upper, "first")
`, LIBS), data));
    close.forEach((c, i) => {
      expect(r.width![i]).toBeCloseTo(4, 9);
      expect(r.sugar![i]).toBeCloseTo(7, 9);
      expect(r["function form"]![i]).toBeCloseTo(5, 9);
      expect(r.side![i]).toBe(c > data.open[i]! ? 1 : 0);
      expect(r.kept![i]).toBe(i + 1);
      expect(r.first![i]).toBe(c + 2);
    });
  });

  it("a library's global code is not part of the script: its plots and inputs do not come over", () => {
    const ok = compile(`//@version=5
indicator("x")
import me/Smooth/1 as s
plot(s.smooth(close), "mine")
`, LIBS);
    expect(ok.plotTitles).toEqual(["mine"]);
    const withInput = compile(`//@version=5
indicator("x")
import me/I/1 as i
plot(i.f(close), "mine")
`, {
      "me/I/1": `//@version=5
library("I")
unused = input.int(5, "never an input of the importer")
export f(series float x) =>
    x
`,
    });
    expect(run(withInput, data, { inputs: { "never an input of the importer": 9 } }).warnings.join(" ")).toMatch(/never an input|matched no input/);
  });

  it("names of the script and of the library do not meet", () => {
    const r = plots(run(compile(`//@version=5
indicator("x")
import me/N/1 as n
helper(x) => x + 1000
total = 7.0
plot(n.viaHelper(close), "lib")
plot(helper(close), "mine")
plot(n.shadow(close), "shadow")
plot(total, "total")
`, {
      "me/N/1": `//@version=5
library("N")
helper(float x) => x + 1
export viaHelper(series float x) => helper(x)
export shadow(series float x) =>
    helper = helper(x) * 2
    helper + 1
`,
    }), data));
    close.forEach((c, i) => {
      expect(r.lib![i]).toBeCloseTo(c + 1, 9);
      expect(r.mine![i]).toBeCloseTo(c + 1000, 9);
      expect(r.shadow![i]).toBeCloseTo((c + 1) * 2 + 1, 9);
      expect(r.total![i]).toBe(7);
    });
  });

  it("a local that takes the alias's name is the local", () => {
    const r = plots(run(compile(`//@version=5
indicator("x")
import me/Smooth/1 as s
f(x) =>
    s = x + 1
    s * 2
plot(f(close), "f")
`, LIBS), data));
    expect(r.f![5]).toBeCloseTo((close[5]! + 1) * 2, 9);
  });

  it("a library can import a library, and one imported twice is one library", () => {
    const libs = {
      "me/Base/1": `//@version=5
library("Base")
export twice(series float x) => x * 2
`,
      "me/Mid/1": `//@version=5
library("Mid")
import me/Base/1 as b
export four(series float x) => b.twice(b.twice(x))
`,
    };
    const r = plots(run(compile(`//@version=5
indicator("x")
import me/Mid/1 as m
import me/Base/1 as b
plot(m.four(close), "four")
plot(b.twice(close), "two")
`, libs), data));
    expect(r.four![3]).toBeCloseTo(close[3]! * 4, 9);
    expect(r.two![3]).toBeCloseTo(close[3]! * 2, 9);
  });

  it("the alias defaults to the library's name, and the source may come from a function", () => {
    const r = transpile(`//@version=5
indicator("x")
import me/Smooth/1
plot(Smooth.smooth(close), "a")
`, { libraries: (p) => (p === "me/Smooth/1" ? SMOOTH : undefined) });
    expect(r.ok).toBe(true);
  });

  it("an alias equal to a builtin namespace adds to it", () => {
    const r = plots(run(compile(`//@version=5
indicator("x")
import me/Ta/1 as ta
plot(ta.mine(close), "mine")
plot(ta.sma(close, 1), "builtin")
`, {
      "me/Ta/1": `//@version=5
library("Ta")
export mine(series float x) => x + 1
`,
    }), data));
    expect(r.mine![2]).toBeCloseTo(close[2]! + 1, 9);
    expect(r.builtin![2]).toBeCloseTo(close[2]!, 9);
  });
});

describe("what is refused, and how it says so", () => {
  const useS = `//@version=5
indicator("x")
import me/Smooth/1 as s
plot(s.hidden(close), "a")
`;

  it("no source: names the library rather than the call", () => {
    expect(errorsOf(useS)[0]).toMatch(/library 'me\/Smooth\/1' \(imported as s\) has no source/);
  });

  it("an import nothing reads still compiles without its source", () => {
    expect(transpile(`//@version=5
indicator("x")
import me/Smooth/1 as s
plot(close, "a")
`).ok).toBe(true);
  });

  it("a name the library does not export, private or absent", () => {
    expect(errorsOf(useS, LIBS)[0]).toMatch(/library 'me\/Smooth\/1' \(imported as s\) does not export 'hidden' \(L4:/);
  });

  it("a type the library does not export, in a type hint", () => {
    const libs = { "me/T/1": `//@version=5\nlibrary("T")\ntype Inner\n    float v\nexport f(float x) => x\n` };
    expect(errorsOf(`//@version=5\nindicator("x")\nimport me/T/1 as t\nf(t.Inner i) => i.v\nplot(t.f(close))\n`, libs)[0]).toMatch(/does not export 'Inner' \(L4:/);
  });

  it("a source that is not a library, or does not parse, or fails analysis says which library", () => {
    const script = `//@version=5
indicator("x")
import me/B/1 as b
plot(b.f(close), "a")
`;
    expect(errorsOf(script, { "me/B/1": `//@version=5\nindicator("nope")\n` })[0]).toMatch(/'me\/B\/1' is not a library/);
    expect(errorsOf(script, { "me/B/1": `//@version=5\nlibrary("B")\nexport f(x) => (\n` })[0]).toMatch(/^library 'me\/B\/1': /);
    const inCode = errorsOf(script, { "me/B/1": `//@version=5\nlibrary("B")\nexport f(series float x) =>\n    nosuch.call(x)\n` });
    expect(inCode.join("\n")).toMatch(/library me\/B\/1 L4:/);
  });

  it("a cycle, and two versions of the rules in one program", () => {
    const cyc = {
      "me/A/1": `//@version=5\nlibrary("A")\nimport me/B/1 as b\nexport f(float x) => b.g(x)\n`,
      "me/B/1": `//@version=5\nlibrary("B")\nimport me/A/1 as a\nexport g(float x) => a.f(x)\n`,
    };
    expect(errorsOf(`//@version=5\nindicator("x")\nimport me/A/1 as a\nplot(a.f(close))\n`, cyc)[0]).toMatch(/imports itself: me\/A\/1 -> me\/B\/1 -> me\/A\/1/);
    expect(errorsOf(`//@version=6\nindicator("x")\nimport me/Smooth/1 as s\nplot(s.smooth(close))\n`, LIBS)[0]).toMatch(/is Pine v5 and the script is v6/);
  });

  it("the same method on the same receiver from two units is refused, not picked between", () => {
    const libs = { "me/M/1": `//@version=5\nlibrary("M")\nexport method plus(float x, float y) => x + y\n` };
    expect(errorsOf(`//@version=5
indicator("x")
import me/M/1 as m
method plus(float x, float y) => x - y
v = close
plot(v.plus(1.0))
`, libs)[0]).toMatch(/method plus on float is declared by both/);
  });

  it("an unresolved import that reads builtins warns, and strict refuses it", () => {
    const script = `//@version=5
indicator("x")
import foo/bar/1 as ta
plot(ta.sma(close, 3))
`;
    const r = compile(script);
    expect(r.warnings.map((w) => w.kind)).toContain("import");
    expect(transpile(script, { strict: true }).ok).toBe(false);
  });

  it("a script with no import compiles to the same code with the option given or not", () => {
    const script = `//@version=5\nindicator("x")\nplot(ta.sma(close, 3))\n`;
    expect(compile(script, LIBS).code).toBe(compile(script).code);
  });
});

describe("a function that returns a matrix is a matrix receiver", () => {
  it("a chained call and a local agree with the same matrix built inline", () => {
    const viaFunction = `//@version=5
indicator("x")
gram(int n, float v) =>
    km = matrix.new<float>(n, n, 0.0)
    for i = 0 to n - 1
        km.set(i, i, v + i)
    km
s = matrix.new<float>(2, 2, 1.0)
a = gram(2, close).sum(s)
b = gram(2, close)
plot(a.get(0, 1), "off")
plot(a.get(1, 1), "diag")
plot(b.transpose().get(1, 1), "local")
plot(gram(2, close).det(), "det")
`;
    const inline = `//@version=5
indicator("x")
km = matrix.new<float>(2, 2, 0.0)
km.set(0, 0, close)
km.set(1, 1, close + 1)
s = matrix.new<float>(2, 2, 1.0)
a = km.sum(s)
plot(a.get(0, 1), "off")
plot(a.get(1, 1), "diag")
plot(km.transpose().get(1, 1), "local")
plot(km.det(), "det")
`;
    const r = plots(run(compile(viaFunction), data));
    expect(r).toEqual(plots(run(compile(inline), data)));
    close.forEach((c, i) => {
      expect(r.off![i]).toBe(1);
      expect(r.diag![i]).toBeCloseTo(c + 2, 9);
      expect(r.det![i]).toBeCloseTo(c * (c + 1), 6);
    });
  });

  it("through an if, and through another function", () => {
    const r = compile(`//@version=5
indicator("x")
pick(bool up) =>
    if up
        matrix.new<float>(2, 2, 1.0)
    else
        matrix.new<float>(2, 2, 2.0)
wrap(bool up) => pick(up)
var m = wrap(true)
plot(wrap(true).sum(), "a")
plot(pick(false).sum(), "b")
plot(m.rows(), "c")
`);
    const p = plots(run(r, data));
    expect(p.a![0]).toBe(4);
    expect(p.b![0]).toBe(8);
    expect(p.c![0]).toBe(2);
  });

  it("a function returning a scalar is still not a matrix", () => {
    expect(transpile(`//@version=5
indicator("x")
f() => 1.0
plot(f().rows())
`).ok).toBe(false);
  });
});

describe("matrix.pinv of an invertible square matrix", () => {
  it("is the inverse, with the accuracy of the inverse, on an ill-conditioned matrix", () => {
    // A regularized RBF kernel matrix, condition number about 1e6. K * pinv(K) must be the identity.
    const r = plots(run(compile(`//@version=5
indicator("x")
n = 40
k = matrix.new<float>(n, n, 0.0)
for i = 0 to n - 1
    for j = 0 to n - 1
        k.set(i, j, math.exp(-math.pow(i - j, 2) / (2.0 * n * n)) + (i == j ? 0.0001 : 0.0))
p = k.mult(k.pinv())
worst = 0.0
for i = 0 to n - 1
    for j = 0 to n - 1
        worst := math.max(worst, math.abs(p.get(i, j) - (i == j ? 1.0 : 0.0)))
plot(worst, "worst")
`), { ...data, open: data.open.slice(0, 2), high: data.high.slice(0, 2), low: data.low.slice(0, 2), close: data.close.slice(0, 2), volume: data.volume.slice(0, 2), time: data.time.slice(0, 2) }));
    expect(r.worst![0]).toBeLessThan(1e-9);
  });
});
