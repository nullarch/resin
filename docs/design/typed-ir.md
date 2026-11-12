# Design: types on every expression, one place that knows them

Status: proposal, nothing here is implemented. It describes the next structural step after the
built-in signature table (`src/transpiler/builtins/`), and the order in which to take it so that no
value a valid script computes changes on the way.

## Why

Three facts about the converter today:

1. **Types are inferred where they happen to be needed.** `inferQualifier` (162 lines, 18 call
   sites), `inferNumType`, `isIntDivision`, `isConstIntExpr`, `isStaticIntExpr`, `isStringExpr` and
   a family of `resolveLocal*` helpers each answer one question about one expression, on demand,
   from the syntax tree and the scope. Two of them can disagree about the same expression, and none
   of them knows a string from a color.
2. **The analyzer's result is 221 fields, 71 of them maps or sets keyed by a syntax node**
   (`idivBinOps`, `concatBinOps`, `stateCallSlots`, `builtinCalls`, ...). Each records one decision
   about one node kind. The code generator (5,447 lines) reads them and writes JavaScript text.
3. **There is no type checker** (`KG-NO-TYPECHECK`). `int x = "a"`, `if "a"`, `"a" * 2`,
   `ta.sma(close, "5")` compile and fail at run time with a raw error, or do not fail. 19 of the 68
   recorded false accepts are of this kind; so is every call the signature check cannot judge
   (`label.new(1)` fills the point overload by count alone).

What "perfect conversion" needs from this layer is modest and specific: every expression has one
recorded type and qualifier, every later decision reads that record, and a script whose types
TradingView refuses is refused here with the same reason.

## The type record

```ts
type Qualifier = "const" | "input" | "simple" | "series";

type PineType =
  | { kind: "int" | "float" | "bool" | "string" | "color" }
  | { kind: "na" }                                  // the untyped na literal, until context types it
  | { kind: "array"; of: PineType }
  | { kind: "matrix"; of: PineType }
  | { kind: "map"; key: PineType; value: PineType }
  | { kind: "udt"; name: string }
  | { kind: "enum"; name: string }
  | { kind: "drawing"; of: "label" | "line" | "box" | "table" | "linefill" | "polyline" | "chart.point" }
  | { kind: "tuple"; of: PineType[] }               // a multi-value return, only as a call result
  | { kind: "void" }
  | { kind: "unknown" };                            // inference gave up; never refused, never trusted

interface TypeInfo { type: PineType; qualifier: Qualifier }
```

`input` is added to the qualifier (the analyzer has three today; the manual has four, and
`request.security`'s `simple` parameters tell them apart). `unknown` is what keeps this safe to
introduce: wherever inference cannot say, the record says so, and every consumer keeps its present
behaviour for `unknown`.

Stored as one `Map<Expr, TypeInfo>` on the analyzed program (`exprTypes`), plus the declared type
of every variable in its scope entry. Not as fields on the syntax nodes: the tree stays what the
parser produced.

## Where the types come from

- **Literals and operators:** the manual's type system page (`language_type-system.txt`) and
  operators page. The rules already implemented piecemeal (`isIntDivision`: v5 const int / const
  int; `isStringExpr`: `+` on strings) move here unchanged, with their tests.
- **Built-in variables:** the constant maps in `analyzer.ts` (`BAR_SERIES_NAMES`,
  `SYMINFO_NUMBER_PROPS`, ...) already say which names are numbers, strings and booleans.
- **Built-in calls:** the signature table. Its annotations are the oracle's Python types today
  (`Series[float]`, `int | float`, `PyneFloat`); a small, explicit mapping turns the ones that are
  unambiguous into `PineType` and leaves the rest `unknown`. The mapping is data with a test that
  lists every annotation it does not understand, so the unknown share is a number that can only
  fall. Qualifiers of built-in parameters are **not** in the oracle; they come from the stored
  reference (`ARG length [series int]`) for the functions it covers and stay unstated elsewhere.
- **User functions, methods, UDT fields:** from their declarations, as `FuncInfo` records them now.

## Order of work

Each step lands on its own, with the whole suite green and the value snapshot of `corpus/` and
`oracle/` identical before and after (the check the verification pass used). Steps 1 to 3 change
no behaviour at all.

1. **Record.** Add `exprTypes` and fill it in one pass at the end of analysis, by calling the
   existing inference helpers. Test: for every expression of every `oracle/cases` script, the
   recorded qualifier equals what `inferQualifier` returns when asked directly. Nothing reads the
   record yet.
2. **One inference.** Replace the bodies of `inferQualifier`, `inferNumType`, `isStringExpr`,
   `isIntDivision` and the `resolveLocal*` helpers with reads of the record, computed bottom-up in
   the same pass that visits the expression. The helpers stay as thin accessors so call sites do
   not move. Test: the step-1 equality, now trivially true, plus the snapshot.
3. **Codegen reads, never infers.** Remove the code generator's own inference call sites (15
   today) in favour of the record, and fold the node-keyed sets that are type decisions
   (`idivBinOps`, `concatBinOps`, the array/map/matrix variable sets) into reads of it. The
   analyzed program loses those fields.
4. **Check, as warnings.** A checker walks the record and reports what the manual forbids:
   declared type against initializer, `:=` changing a type, a non-bool condition, an operator its
   operand types do not have, a built-in argument whose type no overload takes. Only where both
   sides are known; `unknown` never produces a finding. New warning kind `type`.
   Gate: **zero findings on the valid real-world corpus** (2,965 scripts at this writing, measured
   by resin-harness) and on `oracle/cases`. A finding there is a bug in the checker or in the type
   mapping, by definition, and is fixed before anything else. The 19 `static-type` false accepts
   become warnings.
5. **Refuse.** `strict` refuses `type` warnings. Refusing by default is a separate decision, taken
   when the gate has held across at least one more corpus refresh; `HARNESS.md` already says why a
   checker built from memory must not refuse real scripts.
6. **Split the analyzer by what the record made separable.** `analyzer.ts` (9,441 lines) and
   `call-expr.ts` (9,833) are large because every call kind carries its own inference and its own
   bookkeeping. With types read from one place, the per-namespace call handling can move into
   modules that share only the record and the slot allocator. This is last on purpose: splitting
   first would move the tangle, not remove it.

Alongside steps 2 to 4, the per-namespace keyword tables (`STR_KWARG_PARAM_NAMES`,
`ARRAY_KWARG_PARAM_NAMES`, `MATH_KWARG_PARAM_NAMES`, `TA_REGISTRY.kwargParamNames`, ...) are
replaced by reads of the signature table. `tests/unit/builtin_call_check.test.ts` already holds the
two to agreement, so the replacement is mechanical; it waits for step 2 only because both touch the
same call sites.

## What this does not do

- It does not make any built-in's values more correct. That is the harness's work (tier 1 and 2
  evidence per function, `resin-harness/state/coverage.md`).
- It does not add a lower-level IR between the tree and JavaScript. The record on the tree is
  enough for the decisions the code generator makes today; a separate IR would be justified by a
  second back end or by optimisation passes, and there is neither.
- It does not implement Pine v4 and below.

## Risks

- **A wrong type refuses a valid script.** Contained by `unknown`, by warnings before refusal, and
  by the zero-findings gate on real scripts.
- **The oracle's annotations are not Pine types.** They are the oracle author's Python typing and
  are loose in places (`Any`, unannotated parameters). The mapping only trusts the unambiguous
  ones; the rest is `unknown` until the reference text or a TradingView measurement says more.
- **Qualifier rules differ between v5 and v6** (dynamic requests, `simple` versus `series`
  parameters). The record carries the script's version; rules that differ are written twice and
  cite the migration guide.
