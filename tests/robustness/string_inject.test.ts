// Text that means something to JavaScript, HTML, Java-style format strings or a replacement
// pattern, carried through every place a script lets text in: plot, input and indicator titles,
// string literals and what is done to them, str.format patterns and arguments, log and alert
// messages, runtime.error, label text, map keys, strategy ids, comments, line terminators, and
// the strings a host hands to transpile(). Each is run against the same script with plain text:
// the emitted JavaScript must parse, and values must come out equal where equality is meaningful.
// (Identifier names are tests/unit/identifier_hygiene.test.ts.)
import { describe, expect, it } from "vitest";
import { PineRuntimeHaltError, run, transpile, type AnalyzeOptions, type OHLCVData, type RunResult } from "../../src/index";
import type { ContextOptions } from "../../src/runtime/context";
import { makeSyntheticOHLCV } from "../helpers/synthetic";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LIMITS = { maxStepsPerBar: 200_000, maxCollectionLength: 100_000 } as const;
const data = makeSyntheticOHLCV(6, 3);
const HEADER = '//@version=6\nindicator("t")\n';

// Name -> text. Every one is a legal Pine string value; `lit` spells it as a literal the lexer reads back.
const NASTY: [string, string][] = [
  ["plain", "plain"],
  ["double quote", 'quo"te'],
  ["single quote", "sin'gle"],
  ["backslash", "back\\slash"],
  ["backslash-n spelled out", "\\n"],
  ["backslash-u spelled out", "\\u0041"],
  ["lone backslash", "\\"],
  ["backslash quote", '\\"'],
  ["newline", "new\nline"],
  ["tab", "tab\there"],
  ["backtick", "tick`s"],
  ["template placeholder", "dol${x}lar"],
  ["backtick template", "`${process.exit(1)}`"],
  ["dollar-ampersand", "$&"],
  ["dollar-one", "$1"],
  ["dollar-dollar", "$$"],
  ["dollar-backtick", "$`"],
  ["dollar-quote", "$'"],
  ["script close", "</script>"],
  ["script injection", "</script><script>alert(1)</script>"],
  ["html comment", "<!-- x -->"],
  ["comment markers", "*/ x /*"],
  ["line comment marker", "a//b"],
  ["U+2028 and U+2029", `${LS}x${PS}`],
  ["NUL", "\u0000nul"],
  ["emoji", "\ud83d\ude00emoji"],
  ["lone surrogate", "\ud800lone"],
  ["accented", "caf\u00e9"],
  ["no-break space and BOM", "\u00a0\ufeff"],
  ["format braces", "{0}"],
  ["format quoted braces", "'{0}'"],
  ["printf", "%s %d"],
  ["object keys", "__proto__"],
  ["constructor", "constructor"],
  ["toString", "toString"],
  ["hasOwnProperty", "hasOwnProperty"],
  ["long", "x".repeat(5_000)],
  ["empty", ""],
];

// The lexer decodes \n, \\, \" and \' and keeps any other backslash pair as written.
const lit = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';

const FORMAT_SAFE = (s: string): boolean => !/['{}]/.test(s);

function execute(body: string, opts: { header?: string; transpile?: AnalyzeOptions; run?: ContextOptions; data?: OHLCVData } = {}) {
  const t = transpile((opts.header ?? HEADER) + body, { chartTf: "60", ...opts.transpile });
  if (!t.ok) throw new Error(`${t.internal === true ? "INTERNAL " : ""}${t.errors[0]}`);
  // The emitted module has to be loadable JavaScript, whatever text went into it.
  expect(() => new Function("$", "rt", t.code)).not.toThrow();
  const r = run(t, opts.data ?? data, { limits: { ...LIMITS }, ...opts.run });
  return { t, r };
}
const values = (r: RunResult): string => JSON.stringify(r.plots.map((p) => p.values.map((v) => (Number.isNaN(v) ? "NaN" : v))));

// Runs `check` for every nasty string; returns the ones that threw or answered wrong.
function sweep(strings: [string, string][], check: (s: string) => void): string[] {
  const bad: string[] = [];
  for (const [name, s] of strings) {
    try {
      check(s);
    } catch (e) {
      bad.push(`${name}: ${e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : String(e)}`);
    }
  }
  return bad;
}
const ALL = NASTY;
// A source with a bare CR cannot carry the string through a literal unchanged; see "line terminators".
const same = (actual: unknown, expected: unknown): void => expect(actual).toEqual(expected);

describe("titles", () => {
  // An empty title means "no title": the engine names the plot "Plot N", as TradingView does.
  const TITLED = ALL.filter(([, s]) => s !== "");

  it("a plot title comes back exactly, in the transpile result, the run result and the viz metadata", () => {
    const plain = values(execute('plot(close, title="plain")\nplot(open)\n').r);
    expect(sweep(TITLED, (s) => {
      const { t, r } = execute(`plot(close, title=${lit(s)})\nplot(open)\n`);
      same(t.plotTitles[0], s);
      same(r.plots[0]!.title, s);
      same(r.viz!.plots[0]!.title, s);
      same(t.viz.plots[0]!.title, s);
      same(values(r), plain);
    })).toEqual([]);
  });

  it("an indicator title and a strategy title are text, not code", () => {
    const plain = values(execute("plot(close)\n").r);
    expect(sweep(ALL, (s) => {
      same(values(execute("plot(close)\n", { header: `//@version=6\nindicator(${lit(s)})\n` }).r), plain);
      same(values(execute("plot(close)\n", { header: `//@version=6\nstrategy(${lit(s)})\n` }).r), plain);
    })).toEqual([]);
  });

  it("an input title keys the override, however odd (and a default reads when none is given)", () => {
    expect(sweep(TITLED, (s) => {
      const src = `len = input.int(5, ${lit(s)})\nplot(len)\n`;
      same(execute(src).r.plots[0]!.values[0], 5);
      const overridden = execute(src, { run: { inputs: { [s]: 3 } } }).r;
      same(overridden.plots[0]!.values[0], 3);
      same(overridden.warnings, []);
    })).toEqual([]);
  });

  it("input group, tooltip, options and a string default are text", () => {
    expect(sweep(ALL, (s) => {
      const src = `v = input.string(${lit(s)}, "T", options=[${lit(s)}, "other"], group=${lit(s)}, tooltip=${lit(s)})\nplot(str.length(v))\nplot(v == ${lit(s)} ? 1 : 0)\n`;
      const r = execute(src).r;
      same(r.plots[1]!.values[0], 1);
    })).toEqual([]);
  });

  it("hline, plotshape and table text", () => {
    expect(sweep(ALL, (s) => {
      execute(`hline(1, ${lit(s)})\nplotshape(close > open, title=${lit(s)}, text=${lit(s)})\nvar t = table.new(position.top_right, 1, 1)\ntable.cell(t, 0, 0, ${lit(s)})\nplot(1)\n`);
    })).toEqual([]);
  });
});

describe("string values", () => {
  it("a literal keeps its length, equals itself and finds itself inside brackets", () => {
    expect(sweep(ALL, (s) => {
      const src =
        `a = ${lit(s)}\nplot(str.length(a))\nplot(a == ${lit(s)} ? 1 : 0)\nplot(a != ${lit(s + "x")} ? 1 : 0)\n` +
        `plot(str.contains(${lit("[" + s + "]")}, a) ? 1 : 0)\nplot(str.pos(${lit("[" + s + "]")}, a))\n` +
        `plot(str.startswith(${lit(s + "tail")}, a) ? 1 : 0)\nplot(str.endswith(${lit("head" + s)}, a) ? 1 : 0)\n`;
      const v = execute(src).r.plots.map((p) => p.values[0]);
      expect([s.length, [...s].length]).toContain(v[0]);
      // str.pos of the empty string is 0, of any other text 1 (it sits after the opening bracket).
      same(v.slice(1), [1, 1, 1, s === "" ? 0 : 1, 1, 1]);
    })).toEqual([]);
  });

  it("concatenation, substring, upper and lower do not read the text as anything but text", () => {
    expect(sweep(ALL, (s) => {
      const v = execute(`a = ${lit(s)} + ${lit(s)}\nplot(a == ${lit(s + s)} ? 1 : 0)\nplot(str.substring(a, 0, ${s.length}) == ${lit(s)} ? 1 : 0)\nplot(str.lower(${lit(s)}) == ${lit(s.toLowerCase())} ? 1 : 0)\n`).r;
      same(v.plots.map((p) => p.values[0]), [1, 1, 1]);
    })).toEqual([]);
  });

  it("map keys: the names of Object.prototype members are keys like any other", () => {
    expect(sweep(ALL, (s) => {
      const src = `m = map.new<string, float>()\nmap.put(m, ${lit(s)}, 7.0)\nplot(map.get(m, ${lit(s)}))\nplot(map.size(m))\nplot(map.contains(m, "other") ? 1 : 0)\nplot(map.contains(m, ${lit(s + "x")}) ? 1 : 0)\n`;
      same(execute(src).r.plots.map((p) => p.values[0]), [7, 1, 0, 0]);
    })).toEqual([]);
    // Before anything is put: an empty map has none of them.
    expect(execute(`m = map.new<string, float>()\nplot(map.contains(m, "__proto__") ? 1 : 0)\nplot(map.contains(m, "constructor") ? 1 : 0)\nplot(na(map.get(m, "toString")) ? 1 : 0)\n`).r.plots.map((p) => p.values[0])).toEqual([0, 0, 1]);
  });

  it("an unset input title that is an Object.prototype member reads its default", () => {
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const r = execute(`v = input.float(2.5, ${lit(key)})\nplot(v)\n`).r;
      expect(r.plots[0]!.values[0], key).toBe(2.5);
      expect(r.warnings, key).toEqual([]);
    }
  });
});

describe("str.format", () => {
  it("any text passed as an argument comes back unchanged", () => {
    expect(sweep(ALL, (s) => {
      const v = execute(`f = str.format("{0}", ${lit(s)})\nplot(f == ${lit(s)} ? 1 : 0)\nplot(str.length(str.format("<{0}|{0}>", ${lit(s)})))\n`).r;
      same(v.plots[0]!.values[0], 1);
      same(v.plots[1]!.values[0], 2 * s.length + 3);
    })).toEqual([]);
  });

  it("text without format syntax in the pattern is copied", () => {
    expect(sweep(ALL.filter(([, s]) => FORMAT_SAFE(s)), (s) => {
      const v = execute(`plot(str.format(${lit(s + " {0} " + s)}, 5) == ${lit(s + " 5 " + s)} ? 1 : 0)\n`).r;
      same(v.plots[0]!.values[0], 1);
    })).toEqual([]);
  });

  it("braces and quotes in the pattern follow the format grammar, and a bad index is a script error, not an engine error", () => {
    expect(execute(`plot(str.format("it''s {0}", 1) == "it's 1" ? 1 : 0)\n`).r.plots[0]!.values[0]).toBe(1);
    expect(() => execute(`plot(str.length(str.format(${lit("dol${x}lar")}, 1)))\n`)).toThrow(PineRuntimeHaltError);
  });
});

describe("str.replace, str.replace_all, str.split", () => {
  it("a target is matched literally, whatever characters it holds", () => {
    expect(sweep(ALL.filter(([, s]) => s !== "" && s.length < 100), (s) => {
      const v = execute(`plot(str.replace_all(${lit("<" + s + ">")}, ${lit(s)}, "_") == "<_>" ? 1 : 0)\nplot(str.replace(${lit("<" + s + ">")}, ${lit(s)}, "_") == "<_>" ? 1 : 0)\nplot(str.replace(${lit("<" + s + ">")}, ${lit(s)}, "_", 0) == "<_>" ? 1 : 0)\n`).r;
      same(v.plots.map((p) => p.values[0]), [1, 1, 1]);
    })).toEqual([]);
  });

  it("a replacement without $ is copied", () => {
    expect(sweep(ALL.filter(([, s]) => !s.includes("$")), (s) => {
      const v = execute(`plot(str.replace(${lit("a-b")}, "-", ${lit(s)}) == ${lit("a" + s + "b")} ? 1 : 0)\nplot(str.replace_all(${lit("a-b-c")}, "-", ${lit(s)}) == ${lit("a" + s + "b" + s + "c")} ? 1 : 0)\n`).r;
      same(v.plots.map((p) => p.values[0]), [1, 1]);
    })).toEqual([]);
  });

  it("$1 stays $1 (there is no group to substitute)", () => {
    const v = execute(`plot(str.replace_all("a-b", "-", "$1") == "a$1b" ? 1 : 0)\n`).r;
    expect(v.plots[0]!.values[0]).toBe(1);
  });

  // JavaScript's String.prototype.replace reads $&, $$, $` and $' in a string replacement; the
  // replacement here is literal text, as the occurrence-counting form of str.replace (which slices)
  // always was. Fixed: both forms hand the replacement over as a function. (This was KD10.)
  for (const [name, repl] of [["$&", "$&"], ["$$", "$$"], ["$`", "$`"], ["$'", "$'"]] as const) {
    it(`a replacement holding ${name} is inserted literally by str.replace, with and without an occurrence, and str.replace_all`, () => {
      const v = execute(
        `plot(str.replace(${lit("a-b")}, "-", ${lit(repl)}) == ${lit("a" + repl + "b")} ? 1 : 0)\nplot(str.replace_all(${lit("a-b-c")}, "-", ${lit(repl)}) == ${lit("a" + repl + "b" + repl + "c")} ? 1 : 0)\nplot(str.replace(${lit("a-b-c")}, "-", ${lit(repl)}, 1) == ${lit("a" + repl + "b-c")} ? 1 : 0)\n`,
      ).r;
      expect(v.plots.map((p) => p.values[0])).toEqual([1, 1, 1]);
    });
  }

  it("the occurrence form reads $& literally, which is what the plain form should do too", () => {
    expect(execute(`plot(str.replace("a-b", "-", "$&", 1) == "a$&b" ? 1 : 0)\n`).r.plots[0]!.values[0]).toBe(1);
  });

  it("a separator is matched literally", () => {
    expect(sweep(ALL.filter(([, s]) => s !== "" && s.length < 100), (s) => {
      // A text that contains its neighbours' first letters must not confuse the count: p/q/r are not in any of them.
      const v = execute(`a = str.split(${lit("p" + s + "q" + s + "r")}, ${lit(s)})\nplot(array.size(a))\nplot(array.get(a, 0) == "p" ? 1 : 0)\nplot(array.get(a, 2) == "r" ? 1 : 0)\n`).r;
      same(v.plots.map((p) => p.values[0]), [3, 1, 1]);
    })).toEqual([]);
  });
});

describe("messages", () => {
  it("log.* and runtime.warning take any text and change nothing", () => {
    const plain = values(execute("plot(close)\n").r);
    expect(sweep(ALL, (s) => {
      same(values(execute(`log.info(${lit(s)})\nlog.warning(${lit(s)})\nlog.error(${lit(s)})\nruntime.warning(${lit(s)})\nlog.info(${lit("{0} " + s)}, close)\nplot(close)\n`).r), plain);
    })).toEqual([]);
  });

  it("alert and alertcondition take any text and change nothing", () => {
    const plain = values(execute("plot(close)\n").r);
    expect(sweep(ALL, (s) => {
      same(values(execute(`if bar_index == 2\n    alert(${lit(s)}, alert.freq_once_per_bar)\nalertcondition(close > open, ${lit(s)}, ${lit(s)})\nplot(close)\n`).r), plain);
    })).toEqual([]);
  });

  it("runtime.error stops the run with exactly the script's text", () => {
    expect(sweep(ALL, (s) => {
      let caught: unknown = null;
      try {
        execute(`if bar_index == 2\n    runtime.error(${lit(s)})\nplot(1)\n`);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PineRuntimeHaltError);
      same((caught as Error).message, `PineScript runtime error: ${s}`);
    })).toEqual([]);
  });

  it("label text reaches the drawing log as written", () => {
    expect(sweep(ALL, (s) => {
      const r = execute(`if bar_index == 2\n    label.new(bar_index, close, ${lit(s)})\nplot(1)\n`).r;
      expect(r.viz!.drawings.some((d) => d.kind === "label" && d.state.text === s)).toBe(true);
    })).toEqual([]);
  });

  it("strategy ids and comments key orders by their text", () => {
    const strat = (id: string): string => `//@version=6\nstrategy("t")\nif bar_index == 1\n    strategy.entry(${lit(id)}, strategy.long, comment=${lit(id)})\nif bar_index == 3\n    strategy.close(${lit(id)})\nplot(strategy.position_size)\n`;
    expect(sweep(ALL.filter(([, s]) => s !== ""), (s) => {
      const p = execute("", { header: strat(s) }).r.plots[0]!.values;
      expect(p[2], "open after the entry fills").toBeGreaterThan(0);
      same(p[5], 0);
    })).toEqual([]);
  });
});

describe("comments and line terminators", () => {
  const CONTROL = 'plot(close, "A")\nplot(open, "B")\n';
  const control = values(execute(CONTROL).r);
  const noEol = ALL.filter(([, s]) => !/[\n\r]/.test(s));

  it("a comment can hold anything on its own line or after code", () => {
    expect(sweep(noEol, (s) => {
      same(values(execute(`// ${s}\nplot(close, "A") // ${s}\n// ${s}\nplot(open, "B")\n`).r), control);
    })).toEqual([]);
  });

  it("U+2028 and U+2029 are not Pine line ends: inside a comment they are comment text", () => {
    same(values(execute(`plot(close, "A") // x${LS}plot(low)${PS}plot(high)\nplot(open, "B")\n`).r), control);
  });

  it("CRLF, CR-only and mixed line ends read as the same script", () => {
    const lf = `//@version=6\nindicator("t")\n${CONTROL}`;
    const outcomes = [lf.replace(/\n/g, "\r\n"), lf.replace(/\n/g, "\r"), lf.replace(/\n/, "\r\n").replace(/\n/, "\r")];
    for (const src of outcomes) {
      const t = transpile(src, { chartTf: "60" });
      expect(t.ok, t.ok ? "" : t.errors[0]).toBe(true);
      if (t.ok) same(values(run(t, data, { limits: { ...LIMITS } })), control);
    }
  });

  it("a CR or CRLF inside a comment ends it, so what follows is code", () => {
    for (const eol of ["\r", "\r\n"]) {
      same(values(execute(`plot(close, "A") // c${eol}plot(open, "B")\n`).r), control);
    }
  });

  it("a raw CR inside a string literal is read without crashing", () => {
    const t = transpile(`${HEADER}plot(close, title="a\rb")\n`, { chartTf: "60" });
    if (t.ok) expect(["a\rb", "a\nb"]).toContain(t.plotTitles[0]);
    else expect(t.internal).toBeUndefined();
  });

  it("U+2028 outside a string or comment is refused, not misread", () => {
    const t = transpile(`${HEADER}plot(close)${LS}plot(open)\n`, { chartTf: "60" });
    expect(t.ok).toBe(false);
    if (!t.ok) {
      expect(t.internal).toBeUndefined();
      expect(t.errors.join(" ")).toMatch(/U\+2028/);
    }
  });
});

describe("strings the host supplies", () => {
  it("syminfo.ticker and syminfo.prefix are text in the emitted module", () => {
    expect(sweep(ALL.filter(([, s]) => s !== ""), (s) => {
      const r = execute(`plot(syminfo.ticker == ${lit(s)} ? 1 : 0)\nplot(syminfo.prefix == ${lit(s)} ? 1 : 0)\nplot(syminfo.tickerid == ${lit(s + ":" + s)} ? 1 : 0)\n`, {
        transpile: { syminfo: { ticker: s, prefix: s } },
      }).r;
      same(r.plots.map((p) => p.values[0]), [1, 1, 1]);
    })).toEqual([]);
  });

  it("a request.security symbol is matched to its feed by its exact text", () => {
    const feed = { ...data, timeframe: "60" };
    expect(sweep(ALL.filter(([, s]) => s !== "" && !s.includes("\ud800")), (s) => {
      const r = execute(`x = request.security(${lit(s)}, "60", close)\nplot(x)\n`, { run: { security: { [s]: feed } } }).r;
      same(Array.from(r.plots[0]!.values), Array.from(data.close));
      same(r.warnings, []);
    })).toEqual([]);
  });

  it("a timezone that is not a timezone is refused by transpile with a message, never injected", () => {
    for (const [, s] of ALL) {
      const t = transpile(HEADER + "plot(close)\n", { chartTf: "60", syminfo: { timezone: s } });
      expect(t.ok, `timezone ${JSON.stringify(s).slice(0, 40)}`).toBe(false);
      if (!t.ok) expect(t.internal).toBeUndefined();
    }
  });

  it("a symbol list or option name with odd text only produces warnings", () => {
    const t = transpile(HEADER + "plot(close)\n", { chartTf: "60", ...({ ["opt" + LS + '"`${x}']: 1 } as object) } as AnalyzeOptions);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.warnings.some((w) => w.kind === "option")).toBe(true);
  });
});

describe("what the emitted module contains", () => {
  it("every string reaches the module as a quoted literal: the module parses and is not executed by its text", () => {
    // `process.exit(1)` in a template placeholder would end this very test run if the text were evaluated.
    const s = "`${process.exit(1)}`;process.exit(1);//" + LS + "</script>";
    const { t } = execute(`a = ${lit(s)}\nplot(close, title=${lit(s)})\nplot(str.length(a))\nlog.info(a)\n`);
    expect(t.code).toContain(`var a = ${JSON.stringify(s)};`);
  });
});
