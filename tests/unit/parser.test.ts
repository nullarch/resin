import { describe, it, expect } from "vitest";
import { parse, ParseError } from "../../src/transpiler/parser";
import type {
  Assignment,
  BinOp,
  BreakStmt,
  CallExpr,
  ContinueStmt,
  DotAccess,
  EnumDecl,
  ExprStmt,
  FieldAssignment,
  ForInStmt,
  ForStmt,
  FuncDecl,
  IfStmt,
  IndexAccess,
  MethodDecl,
  SwitchStmt,
  TernaryOp,
  TupleDestructure,
  TupleExpr,
  TypeDecl,
  UnaryOp,
  VarDecl,
  WhileStmt,
} from "../../src/transpiler/ast";

describe("Parser", () => {
  it("parses a var declaration with type hint", () => {
    const script = parse("var float acc = 0.0");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.name).toBe("acc");
    expect(stmt.typeHint).toBe("float");
    expect(stmt.value).toMatchObject({ kind: "NumberLiteral", value: 0 });
  });

  it("parses a var declaration without type hint", () => {
    const script = parse("var acc = 0.0");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBeNull();
    expect(stmt.name).toBe("acc");
  });

  it("parses walrus reassignment", () => {
    const script = parse("acc := acc + close");
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe(":=");
    expect(stmt.name).toBe("acc");
    expect(stmt.value).toMatchObject({ kind: "BinOp", op: "+" });
  });

  it("parses '=' simple assignment", () => {
    const script = parse("sma3 = close");
    const stmt = script.body[0] as Assignment;
    expect(stmt.operator).toBe("=");
    expect(stmt.name).toBe("sma3");
  });

  it("respects * / precedence over + -", () => {
    const script = parse("x = 1 + 2 * 3");
    const stmt = script.body[0] as Assignment;
    const bin = stmt.value as BinOp;
    expect(bin.op).toBe("+");
    expect(bin.right).toMatchObject({ kind: "BinOp", op: "*" });
  });

  // C195 parser 감사 발견: PERCENT/PLUS_ASSIGN/MINUS_ASSIGN/STAR_ASSIGN/SLASH_ASSIGN/
  // PERCENT_ASSIGN은 렉서가 이미 별도 토큰으로 방출했지만(lexer.test.ts "tokenizes compound
  // assignment operators distinctly from ASSIGN") 파서 어디서도 소비하지 않아 `a % b`/`x += 1`
  // 전부 ParseError였다(오직 토큰화만 검증됐을 뿐 파서 배선이 없었음).
  it("parses '%' as a BinOp with the same precedence as * and /", () => {
    const script = parse("x = 1 + 2 % 3");
    const stmt = script.body[0] as Assignment;
    const bin = stmt.value as BinOp;
    expect(bin.op).toBe("+");
    expect(bin.right).toMatchObject({ kind: "BinOp", op: "%" });
  });

  it.each([
    ["+=", "+"],
    ["-=", "-"],
    ["*=", "*"],
    ["/=", "/"],
    ["%=", "%"],
  ] as const)("desugars 'x %s value' into Assignment(':=', BinOp('%s', x, value))", (opTok, op) => {
    const script = parse(`x ${opTok} value`);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe(":=");
    expect(stmt.name).toBe("x");
    const bin = stmt.value as BinOp;
    expect(bin.kind).toBe("BinOp");
    expect(bin.op).toBe(op);
    expect(bin.left).toMatchObject({ kind: "Identifier", name: "x" });
    expect(bin.right).toMatchObject({ kind: "Identifier", name: "value" });
  });

  it("desugars 'count += 1' with a literal RHS", () => {
    const script = parse("count += 1");
    const stmt = script.body[0] as Assignment;
    const bin = stmt.value as BinOp;
    expect(bin.op).toBe("+");
    expect(bin.left).toMatchObject({ kind: "Identifier", name: "count" });
    expect(bin.right).toMatchObject({ kind: "NumberLiteral", value: 1 });
  });

  // C261: obj.field += value 신규 지원(WALRUS 'obj.field := value' FieldAssignment 분기와
  // 동일 시맨틱 확장). 위 it.each가 검증한 Identifier 타깃 데슈가링과 나란히, DotAccess 타깃은
  // Assignment 대신 FieldAssignment(object/field 분리 + value가 BinOp)로 데슈가링된다.
  it.each([
    ["+=", "+"],
    ["-=", "-"],
    ["*=", "*"],
    ["/=", "/"],
    ["%=", "%"],
  ] as const)("desugars 'obj.field %s value' into FieldAssignment(object, field, BinOp('%s', obj.field, value))", (opTok, op) => {
    const script = parse(`obj.field ${opTok} value`);
    const stmt = script.body[0] as FieldAssignment;
    expect(stmt.kind).toBe("FieldAssignment");
    expect(stmt.object).toMatchObject({ kind: "Identifier", name: "obj" });
    expect(stmt.field).toBe("field");
    const bin = stmt.value as BinOp;
    expect(bin.kind).toBe("BinOp");
    expect(bin.op).toBe(op);
    expect(bin.left).toMatchObject({ kind: "DotAccess", attr: "field" });
    expect(bin.right).toMatchObject({ kind: "Identifier", name: "value" });
  });

  it("parses parenthesized expressions", () => {
    const script = parse("x = (1 + 2) * 3");
    const stmt = script.body[0] as Assignment;
    const bin = stmt.value as BinOp;
    expect(bin.op).toBe("*");
    expect(bin.left).toMatchObject({ kind: "BinOp", op: "+" });
  });

  it("parses dotted call expressions (ta.sma)", () => {
    const script = parse("sma3 = ta.sma(close, 3)");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "DotAccess", attr: "sma" });
    expect(call.args).toHaveLength(2);
  });

  it("parses indicator() as a bare call statement", () => {
    const script = parse('indicator("smoke")');
    const stmt = script.body[0] as ExprStmt;
    expect(stmt.kind).toBe("ExprStmt");
    const call = stmt.expr as CallExpr;
    expect(call.callee).toMatchObject({ kind: "Identifier", name: "indicator" });
    expect(call.args[0]).toMatchObject({ kind: "StringLiteral", value: "smoke" });
  });

  it("parses na literal", () => {
    const script = parse("var float x = na");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.value.kind).toBe("NaLiteral");
  });

  // na(x) 함수 호출형(pine2py parser.py _parse_primary L830-835과 동일한 1토큰 lookahead —
  // NA 토큰 소비 직후 다음 토큰이 LPAREN이면 Identifier(name:"na")로 낮춰 parsePostfix의
  // 호출 가능 대상 가드를 통과시킨다) — na 미지원 시 이전엔 "호출 가능한 대상이 아님" ParseError.
  it("parses na(x) as a CallExpr with a bare Identifier callee named 'na'", () => {
    const script = parse("y = na(close)");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "Identifier", name: "na" });
    expect(call.args).toHaveLength(1);
  });

  // 괄호 없는 ta.* 암묵 호출 9종(TV 문법, pine2py codegen.py TA_IMPLICIT_CALL 리터럴 포트 —
  // corpus P4 스캔 "네임스페이스 접근은 호출식만 지원" 클러스터 최다 하위패턴, 20/35파일).
  // `ta.tr`(괄호 없음)를 `ta.tr()`와 동일한 0-인자 CallExpr로 desugar해 그 아래 analyzer/codegen은
  // 기존 명시적 호출 경로를 그대로 재사용한다.
  it.each(["tr", "accdist", "wad", "wvad", "iii", "obv", "pvt", "nvi", "pvi"])(
    "desugars bare 'ta.%s' (no parens) into a 0-arg CallExpr over the DotAccess",
    (attr) => {
      const script = parse(`x = ta.${attr}`);
      const stmt = script.body[0] as Assignment;
      const call = stmt.value as CallExpr;
      expect(call.kind).toBe("CallExpr");
      expect(call.callee).toMatchObject({ kind: "DotAccess", attr, obj: { kind: "Identifier", name: "ta" } });
      expect(call.args).toHaveLength(0);
      expect(call.kwargs).toHaveLength(0);
    },
  );

  it("does NOT desugar bare 'ta.sma' (not in the implicit-call whitelist) — stays a plain DotAccess", () => {
    const script = parse("x = ta.sma");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "DotAccess", attr: "sma" });
  });

  it("does not desugar 'ta.tr()' twice (explicit parens still produce a single normal CallExpr)", () => {
    const script = parse("x = ta.tr()");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "DotAccess", attr: "tr" });
    expect(call.args).toHaveLength(0);
  });

  // C466: 괄호 없는 ta.vwap(단일 사례, wild 33건, corpus P4 "네임스페이스 접근은 호출식만 지원"
  // 클러스터 최다 하위패턴) — 위 9종과 달리 TA_REGISTRY.minArgCount:1(source 필수)이라 0-인자가
  // 아니라 명시적 hlc3(세션 기본 소스) 1-인자 CallExpr로 desugar한다.
  it("desugars bare 'ta.vwap' (no parens) into a 1-arg CallExpr with an injected hlc3 source", () => {
    const script = parse("x = ta.vwap");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "DotAccess", attr: "vwap", obj: { kind: "Identifier", name: "ta" } });
    expect(call.args).toHaveLength(1);
    expect(call.args[0]).toMatchObject({ kind: "Identifier", name: "hlc3" });
    expect(call.kwargs).toHaveLength(0);
  });

  it("does not desugar 'ta.vwap(close)' twice (explicit arg form stays a single normal CallExpr)", () => {
    const script = parse("x = ta.vwap(close)");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "DotAccess", attr: "vwap" });
    expect(call.args).toHaveLength(1);
    expect(call.args[0]).toMatchObject({ kind: "Identifier", name: "close" });
  });

  // C524: `ta.tr[i]`/`ta.obv[1]`류(wild 실측, 04e9d87246af.pine/f1c7f5b22641.pine) — bare 암묵 호출
  // desugar가 예전엔 postfix 루프 종료 후에만 적용돼, 그 직후 '['가 오면(IndexAccess obj 위치)
  // desugar 전 DotAccess가 그대로 obj로 잡혀 analyzer가 "히스토리 인덱스는 식별자에만 지원"으로
  // 오분류했다. IndexAccess.obj가 항상 CallExpr(0-인자)이어야 기존 taCallHistorySlots 히스토리
  // 인덱싱 경로(analyzer/index-access.ts CallExpr 분기)를 그대로 탄다.
  it.each(["tr", "accdist", "wad", "wvad", "iii", "obv", "pvt", "nvi", "pvi"])(
    "desugars 'ta.%s[1]' (no parens, history-indexed) into an IndexAccess over a 0-arg CallExpr",
    (attr) => {
      const script = parse(`x = ta.${attr}[1]`);
      const stmt = script.body[0] as Assignment;
      const idx = stmt.value as IndexAccess;
      expect(idx.kind).toBe("IndexAccess");
      expect(idx.index).toMatchObject({ kind: "NumberLiteral", value: 1 });
      const call = idx.obj as CallExpr;
      expect(call.kind).toBe("CallExpr");
      expect(call.callee).toMatchObject({ kind: "DotAccess", attr, obj: { kind: "Identifier", name: "ta" } });
      expect(call.args).toHaveLength(0);
    },
  );

  it("desugars 'ta.vwap[1]' (no parens, history-indexed) into an IndexAccess over a 1-arg hlc3 CallExpr", () => {
    const script = parse("x = ta.vwap[1]");
    const stmt = script.body[0] as Assignment;
    const idx = stmt.value as IndexAccess;
    expect(idx.kind).toBe("IndexAccess");
    const call = idx.obj as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "DotAccess", attr: "vwap" });
    expect(call.args).toHaveLength(1);
    expect(call.args[0]).toMatchObject({ kind: "Identifier", name: "hlc3" });
  });

  it("does not double-desugar 'ta.tr()[1]' (explicit parens, history-indexed) — obj stays a single normal CallExpr", () => {
    const script = parse("x = ta.tr()[1]");
    const stmt = script.body[0] as Assignment;
    const idx = stmt.value as IndexAccess;
    const call = idx.obj as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "DotAccess", attr: "tr" });
    expect(call.args).toHaveLength(0);
  });

  it("parses unary minus", () => {
    const script = parse("x = -close");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "UnaryOp", op: "-" });
  });

  // C195 parser 감사 발견: parseUnary가 MINUS만 처리하고 PLUS 분기가 아예 없어 `x = +5`가
  // parsePrimary까지 떨어져 "예상치 못한 토큰 PLUS"로 죽었다(pine2py parser.py `_parse_unary`는
  // PLUS를 토큰만 소비하는 no-op으로 처리). AST에 UnaryOp("+") 노드를 만들지 않고 그대로 피연산자를
  // 반환하도록 수정.
  it("parses unary plus as a no-op (no UnaryOp node — same value as the bare operand)", () => {
    const script = parse("x = +5");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "NumberLiteral", value: 5 });
  });

  it("parses unary plus in front of an identifier", () => {
    const script = parse("x = +close");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "Identifier", name: "close" });
  });

  it("parses repeated unary +/- combinations", () => {
    const script = parse("x = -+-close");
    const stmt = script.body[0] as Assignment;
    // -(+(-close)) -- 바깥 '-'만 UnaryOp로 남고 '+'는 소비되어 사라짐
    expect(stmt.value).toMatchObject({ kind: "UnaryOp", op: "-", operand: { kind: "UnaryOp", op: "-" } });
  });

  it("parses multiple statements separated by newlines", () => {
    const script = parse("var float acc = 0.0\nacc := acc + close\nsma3 = ta.sma(close, 3)");
    expect(script.body).toHaveLength(3);
  });

  it("throws ParseError on an unexpected token", () => {
    expect(() => parse("x = +")).toThrow(ParseError);
  });

  it("throws ParseError when calling a non-callable expression", () => {
    expect(() => parse("x = 1(2)")).toThrow(ParseError);
  });

  // ── 표현식 우선순위 확장: 비교/논리/삼항 ─────────────────

  it("parses comparison operators", () => {
    for (const [src, op] of [
      ["x = close == open", "=="],
      ["x = close != open", "!="],
      ["x = close < open", "<"],
      ["x = close > open", ">"],
      ["x = close <= open", "<="],
      ["x = close >= open", ">="],
    ] as const) {
      const script = parse(src);
      const stmt = script.body[0] as Assignment;
      expect((stmt.value as BinOp).op).toBe(op);
    }
  });

  it("parses 'and'/'or' with lower precedence than comparison", () => {
    const script = parse("x = close > open and volume > 0 or close < open");
    const stmt = script.body[0] as Assignment;
    const top = stmt.value as BinOp;
    expect(top.op).toBe("or");
    const left = top.left as BinOp;
    expect(left.op).toBe("and");
    expect(left.left).toMatchObject({ kind: "BinOp", op: ">" });
  });

  it("parses 'not' as a unary operator binding tighter than 'and'", () => {
    const script = parse("x = not close > open");
    const stmt = script.body[0] as Assignment;
    const unary = stmt.value as UnaryOp;
    expect(unary.kind).toBe("UnaryOp");
    expect(unary.op).toBe("not");
    expect(unary.operand).toMatchObject({ kind: "BinOp", op: ">" });
  });

  it("parses a ternary expression, right-associative on the false branch", () => {
    const script = parse("x = close > open ? 1 : close < open ? -1 : 0");
    const stmt = script.body[0] as Assignment;
    const ternary = stmt.value as TernaryOp;
    expect(ternary.kind).toBe("TernaryOp");
    expect(ternary.condition).toMatchObject({ kind: "BinOp", op: ">" });
    expect(ternary.trueExpr).toMatchObject({ kind: "NumberLiteral", value: 1 });
    expect((ternary.falseExpr as TernaryOp).kind).toBe("TernaryOp");
  });

  // ── if/elif/else ─────────────────────────────────────────

  it("parses a bare if with no else", () => {
    const script = parse("if close > open\n    x := 1");
    const stmt = script.body[0] as IfStmt;
    expect(stmt.kind).toBe("IfStmt");
    expect(stmt.condition).toMatchObject({ kind: "BinOp", op: ">" });
    expect(stmt.thenBody).toHaveLength(1);
    expect(stmt.elifClauses).toHaveLength(0);
    expect(stmt.elseBody).toBeNull();
  });

  it("parses if/else", () => {
    const script = parse("if close > open\n    x := 1\nelse\n    x := 2");
    const stmt = script.body[0] as IfStmt;
    expect(stmt.thenBody).toHaveLength(1);
    expect(stmt.elseBody).toHaveLength(1);
    expect((stmt.elseBody![0] as Assignment).value).toMatchObject({ kind: "NumberLiteral", value: 2 });
  });

  it("parses if/else if/else chains", () => {
    const script = parse(
      "if close > open\n    x := 1\nelse if close < open\n    x := 2\nelse\n    x := 3",
    );
    const stmt = script.body[0] as IfStmt;
    expect(stmt.elifClauses).toHaveLength(1);
    expect(stmt.elifClauses[0]!.condition).toMatchObject({ kind: "BinOp", op: "<" });
    expect(stmt.elseBody).toHaveLength(1);
  });

  it("parses nested if inside a for-loop body", () => {
    const script = parse("for i = 0 to 9\n    if i > 5\n        x := i");
    const forStmt = script.body[0] as ForStmt;
    expect(forStmt.body).toHaveLength(1);
    expect(forStmt.body[0]!.kind).toBe("IfStmt");
  });

  // ── for ──────────────────────────────────────────────────

  it("parses a for-loop with default step", () => {
    const script = parse("for i = 0 to 9\n    x := i");
    const stmt = script.body[0] as ForStmt;
    expect(stmt.kind).toBe("ForStmt");
    expect(stmt.varName).toBe("i");
    expect(stmt.start).toMatchObject({ kind: "NumberLiteral", value: 0 });
    expect(stmt.end).toMatchObject({ kind: "NumberLiteral", value: 9 });
    expect(stmt.step).toBeNull();
    expect(stmt.body).toHaveLength(1);
  });

  it("parses a for-loop with an explicit 'by' step", () => {
    const script = parse("for i = 10 to 0 by -1\n    x := i");
    const stmt = script.body[0] as ForStmt;
    expect(stmt.step).toMatchObject({ kind: "UnaryOp", op: "-" });
  });

  // ── for TYPE name = start to end (C689, wild 실측: `for int i=1 to length`) ─────────────
  // pine2py도 동일 latent 파서 버그(var_name = self._expect(IDENTIFIER) 직후 바로 ASSIGN을
  // 기대해 타입 토큰을 못 받음, python 직접 실행 재현 확인)라 오라클 골든 생성 불가 —
  // hand-verified(타입 없는 for-루프와 동일 AST/실행 결과)로 대체.

  it("parses 'for int i = start to end' with the type token discarded (varName/start/end unaffected)", () => {
    const script = parse("for int i = 0 to 9\n    x := i");
    const stmt = script.body[0] as ForStmt;
    expect(stmt.kind).toBe("ForStmt");
    expect(stmt.varName).toBe("i");
    expect(stmt.start).toMatchObject({ kind: "NumberLiteral", value: 0 });
    expect(stmt.end).toMatchObject({ kind: "NumberLiteral", value: 9 });
    expect(stmt.step).toBeNull();
  });

  it("parses 'for float i = start to end by step' with a non-int type keyword and explicit step", () => {
    const script = parse("for float i = 10 to 0 by -1\n    x := i");
    const stmt = script.body[0] as ForStmt;
    expect(stmt.varName).toBe("i");
    expect(stmt.step).toMatchObject({ kind: "UnaryOp", op: "-" });
  });

  it("still parses a bare 'for x in arr' loop when the candidate type-lookahead sees 'in' next (no regression)", () => {
    // TYPE-lookahead는 peek(1).value==="in"일 때 명시적으로 제외해 for-in과 겹치지 않는다.
    const script = parse("for x in arr\n    y := x");
    const stmt = script.body[0] as ForInStmt;
    expect(stmt.kind).toBe("ForInStmt");
    expect(stmt.varName).toBe("x");
  });

  it("still parses 'for i = 0 to 3' (no type prefix) unaffected by the new type-lookahead", () => {
    const script = parse("for i = 0 to 3\n    x := i");
    const stmt = script.body[0] as ForStmt;
    expect(stmt.kind).toBe("ForStmt");
    expect(stmt.varName).toBe("i");
  });

  // ── for-in (C215, pine2py parser.py _parse_for LBRACKET/bare-IDENTIFIER 'in' 분기) ──────

  it("parses a bare 'for x in arr' loop into a ForInStmt with indexName null", () => {
    const script = parse("for x in arr\n    y := x");
    const stmt = script.body[0] as ForInStmt;
    expect(stmt.kind).toBe("ForInStmt");
    expect(stmt.varName).toBe("x");
    expect(stmt.indexName).toBeNull();
    expect(stmt.iterable).toMatchObject({ kind: "Identifier", name: "arr" });
    expect(stmt.body).toHaveLength(1);
  });

  it("parses a 'for [idx, val] in arr' tuple destructure loop", () => {
    const script = parse("for [i, v] in arr\n    y := v + i");
    const stmt = script.body[0] as ForInStmt;
    expect(stmt.kind).toBe("ForInStmt");
    expect(stmt.indexName).toBe("i");
    expect(stmt.varName).toBe("v");
    expect(stmt.iterable).toMatchObject({ kind: "Identifier", name: "arr" });
  });

  it("parses a single-name 'for [v] in arr' bracket form with indexName null (pine2py structural parity)", () => {
    const script = parse("for [v] in arr\n    y := v");
    const stmt = script.body[0] as ForInStmt;
    expect(stmt.varName).toBe("v");
    expect(stmt.indexName).toBeNull();
  });

  it("parses a for-in loop whose iterable is a more complex expression, not just a bare identifier", () => {
    const script = parse("for x in array.slice(arr, 0, 2)\n    y := x");
    const stmt = script.body[0] as ForInStmt;
    expect(stmt.iterable).toMatchObject({ kind: "CallExpr" });
  });

  it("parses nested if inside a for-in loop body", () => {
    const script = parse("for x in arr\n    if x > 0\n        y := x");
    const stmt = script.body[0] as ForInStmt;
    expect(stmt.body).toHaveLength(1);
    expect(stmt.body[0]!.kind).toBe("IfStmt");
  });

  it("still parses a range for-loop whose variable happens to be named 'in' (regression: no residual ambiguity from 'in' lookahead)", () => {
    // pine2py의 'in' 판별은 IDENTIFIER 토큰 값 비교라 변수명 자체가 'in'이어도 range-for 문법
    // (다음 토큰이 '='라 for-in 분기로 안 빠짐)엔 영향이 없음 — 무회귀 확인.
    const script = parse("for i = 0 to 3\n    x := i");
    expect(script.body[0]!.kind).toBe("ForStmt");
  });

  it("rejects for-in used in a control-flow-expression (value) position with a dedicated ParseError", () => {
    expect(() => parse("y = for x in arr\n    x")).toThrow(ParseError);
    expect(() => parse("y = for x in arr\n    x")).toThrow(/for-in/);
  });

  it("rejects for-in used as a ':=' assignment value with a dedicated ParseError (not a generic 'unexpected token')", () => {
    expect(() => parse("y := for [i, v] in arr\n    v")).toThrow(/for-in/);
  });

  // ── while ────────────────────────────────────────────────

  it("parses a while loop", () => {
    const script = parse("while x < 10\n    x := x + 1");
    const stmt = script.body[0] as WhileStmt;
    expect(stmt.kind).toBe("WhileStmt");
    expect(stmt.condition).toMatchObject({ kind: "BinOp", op: "<" });
    expect(stmt.body).toHaveLength(1);
  });

  // ── break / continue ────────────────────────────────────

  it("parses break and continue inside a while body", () => {
    const script = parse("while x < 10\n    break\n    continue");
    const stmt = script.body[0] as WhileStmt;
    expect((stmt.body[0] as BreakStmt).kind).toBe("BreakStmt");
    expect((stmt.body[1] as ContinueStmt).kind).toBe("ContinueStmt");
  });

  // ── switch ───────────────────────────────────────────────

  it("parses a switch with a subject and a default case", () => {
    const script = parse(["switch x", "    1 => 1", "    2 => 2", "    => 0"].join("\n"));
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.kind).toBe("SwitchStmt");
    expect(stmt.subject).toMatchObject({ kind: "Identifier", name: "x" });
    expect(stmt.cases).toHaveLength(3);
    expect(stmt.cases[0]!.values).toMatchObject([{ kind: "NumberLiteral", value: 1 }]);
    expect(stmt.cases[2]!.values).toBeNull();
  });

  it("parses a switch without a subject (boolean cases)", () => {
    const script = parse(["switch", "    close > open => 1", "    => 0"].join("\n"));
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.subject).toBeNull();
    expect(stmt.cases[0]!.values).toMatchObject([{ kind: "BinOp", op: ">" }]);
  });

  it("parses multi-value switch cases (comma-separated)", () => {
    const script = parse(["switch x", "    1, 2 => 1", "    => 0"].join("\n"));
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.cases[0]!.values).toHaveLength(2);
  });

  it("parses an indented-block switch case body", () => {
    const script = parse(
      ["switch x", "    1 =>", "        y := 1", "        z := 2", "    => 0"].join("\n"),
    );
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.cases[0]!.body).toHaveLength(2);
  });

  // ── UDF 선언 (name(params) => body) ───────────────────────

  it("parses a UDF declaration with a single-line expression body", () => {
    const script = parse("f(x) => x + 1");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.kind).toBe("FuncDecl");
    expect(stmt.name).toBe("f");
    expect(stmt.params).toHaveLength(1);
    expect(stmt.params[0]!.name).toBe("x");
    expect(stmt.body).toHaveLength(1);
    expect(stmt.body[0]!.kind).toBe("ExprStmt");
  });

  it("parses a UDF declaration with an indented block body", () => {
    const script = parse(["f(x) =>", "    y = x + 1", "    y * 2"].join("\n"));
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.body).toHaveLength(2);
    expect(stmt.body[0]!.kind).toBe("Assignment");
    expect(stmt.body[1]!.kind).toBe("ExprStmt");
  });

  it("parses UDF params with a type hint and a default value", () => {
    const script = parse("f(float x, y = 5) => x + y");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("float");
    expect(stmt.params[0]!.name).toBe("x");
    expect(stmt.params[0]!.default).toBeNull();
    expect(stmt.params[1]!.name).toBe("y");
    expect(stmt.params[1]!.default).toMatchObject({ kind: "NumberLiteral", value: 5 });
  });

  it("parses UDF params with 'series'/'simple' qualifiers", () => {
    const script = parse("f(series float src) => src");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("series float");
    expect(stmt.params[0]!.name).toBe("src");
  });

  // C558: wild "expected IDENTIFIER in function parameter, got COMMA"(18건) — `series`/`simple`은
  // 한정자 키워드지만, 뒤에 아무 타입도 안 이어지면(콤마/닫는 괄호/기본값 '='가 바로 옴) TV는 그
  // 토큰 자체를 파라미터 "이름"으로 받아들인다(wild `pctrank(series, period) =>`/
  // `plotCondition(series, condition, labelTrue, labelFalse, yOffset) =>` 관용구). 이전엔
  // parseFuncParam이 SERIES/SIMPLE을 무조건 한정자로 소비해 뒤이은 콤마를 이름 자리에서
  // "expected IDENTIFIER ... got COMMA"로 하드 거부했다.
  describe("bare 'series'/'simple' as a function parameter name (no type follows, C558)", () => {
    it("parses 'pctrank(series, period) => ...' with 'series' as a plain (untyped) param name", () => {
      const script = parse("pctrank(series, period) =>\n    0.0\n");
      const stmt = script.body[0] as FuncDecl;
      expect(stmt.params).toHaveLength(2);
      expect(stmt.params[0]).toMatchObject({ kind: "FuncParam", name: "series", typeHint: null, default: null });
      expect(stmt.params[1]).toMatchObject({ kind: "FuncParam", name: "period", typeHint: null, default: null });
    });

    it("parses 'simple' as a bare param name too (symmetric with 'series')", () => {
      const script = parse("f(simple, x) => simple + x");
      const stmt = script.body[0] as FuncDecl;
      expect(stmt.params[0]).toMatchObject({ name: "simple", typeHint: null });
      expect(stmt.params[1]).toMatchObject({ name: "x", typeHint: null });
    });

    it("parses a lone bare 'series' param immediately before the closing paren", () => {
      const script = parse("f(series) => series");
      const stmt = script.body[0] as FuncDecl;
      expect(stmt.params).toHaveLength(1);
      expect(stmt.params[0]).toMatchObject({ name: "series", typeHint: null, default: null });
    });

    it("parses a bare 'series' param with a default value ('series = 5')", () => {
      const script = parse("f(series = 5) => series");
      const stmt = script.body[0] as FuncDecl;
      expect(stmt.params[0]!.name).toBe("series");
      expect(stmt.params[0]!.typeHint).toBeNull();
      expect(stmt.params[0]!.default).toMatchObject({ kind: "NumberLiteral", value: 5 });
    });

    it("allows the function body to reference the bare 'series' param name (index access + call arg)", () => {
      const script = parse("pctrank(series, period) =>\n    a = series[1]\n    b = na(series)\n    a + b\n");
      const fn = script.body[0] as FuncDecl;
      const aDecl = fn.body[0] as Assignment;
      expect(aDecl.value).toMatchObject({
        kind: "IndexAccess",
        obj: { kind: "Identifier", name: "series" },
      });
    });

    it("does not regress the qualifier form when a type DOES follow ('series float src')", () => {
      const script = parse("f(series float src, simple int n) => src");
      const stmt = script.body[0] as FuncDecl;
      expect(stmt.params[0]).toMatchObject({ name: "src", typeHint: "series float" });
      expect(stmt.params[1]).toMatchObject({ name: "n", typeHint: "simple int" });
    });

    // C596: parseVarDecl(L924)/parseAssignmentOrExpr(L1023,1034)은 "series"/"simple"과 나란히
    // "const"도 이미 체크했지만(C558) parseFuncParam만 CONST 토큰을 빠뜨려 `f(const int x) => ...`가
    // "expected IDENTIFIER ... got CONST"로 거부됐다(wild corpus/wild/scripts_v56/79cd3b3402dd.pine
    // 등 clusterSize=6). "series"/"simple"과 완전히 대칭으로 지원.
    it("parses 'const' as a UDF param qualifier, symmetric with 'series'/'simple' (C596)", () => {
      const script = parse("add(const int x, const int y) => x + y");
      const stmt = script.body[0] as FuncDecl;
      expect(stmt.params[0]).toMatchObject({ name: "x", typeHint: "const int" });
      expect(stmt.params[1]).toMatchObject({ name: "y", typeHint: "const int" });
    });

    it("mixes 'const' with 'series'/'simple' qualifiers across params in the same signature (C596)", () => {
      const script = parse("f(series float a, simple int b, const bool c) => a");
      const stmt = script.body[0] as FuncDecl;
      expect(stmt.params[0]).toMatchObject({ name: "a", typeHint: "series float" });
      expect(stmt.params[1]).toMatchObject({ name: "b", typeHint: "simple int" });
      expect(stmt.params[2]).toMatchObject({ name: "c", typeHint: "const bool" });
    });

    it("routes a method declaration's bare 'series' param through the same shared parseFuncParam", () => {
      const script = parse("method f(series, x) => series + x");
      const stmt = script.body[0] as MethodDecl;
      expect(stmt.kind).toBe("MethodDecl");
      expect(stmt.params[0]).toMatchObject({ name: "series", typeHint: null });
    });

    // Statement-level qualifier declarations are a separate grammar position (parseAssignmentOrExpr)
    // from function parameters -- a bare qualifier there still has no valid Pine meaning (no type,
    // no function-parameter "name" context) and must keep throwing, not silently split into two
    // statements (`series` ExprStmt + `x = 1` Assignment, the C212 silent-mis-split class).
    it("still throws for a bare qualifier at statement level with no type ('series x = 1')", () => {
      expect(() => parse("series x = 1")).toThrow(ParseError);
    });

    it("still throws for 'simple y = 1' at statement level (same ambiguous shape)", () => {
      expect(() => parse("simple y = 1")).toThrow(ParseError);
    });
  });

  // C660: wild v2 corpus_scan "알 수 없는 식별자" 클러스터 실갭(next_hint(C659) 조사). C558은
  // SERIES/SIMPLE이 함수 "파라미터 이름" 자리에서 bare 채택되는 것만 다뤘다 -- "타입 바로 다음은
  // 반드시 이름"인 나머지 고정 슬롯(var/local 선언 신규, UDT 필드, DotAccess 읽기)에서 이름이
  // 우연히 "simple"/"series"와 겹치면(`float simple = ...`, wild 02906eab87a4.pine 실측) 그 이름
  // 토큰이 IDENTIFIER가 아니라 SERIES/SIMPLE 토큰 타입이라 "타입 다음 IDENTIFIER" lookahead가
  // 실패해 타입 토큰만 별개의 미해결 ExprStmt(Identifier)로 떨어져 나갔다(C212와 동일한 침묵
  // 오분할 클래스, analyzer가 그 타입 이름을 "알 수 없는 식별자"로 거부). isBareNameQualifier
  // 헬퍼로 5개 문법 슬롯(var 선언 무타입/유타입, non-var 로컬 유타입/무초기값, 함수 파라미터,
  // UDT 필드, DotAccess 읽기)을 한 번에 대칭 확장. CONST는 제외(parsePrimary가 bare 값으로
  // 인정하는 곳이 없어 반쪽짜리 지원이 됨, wild 근거도 없음).
  describe("'series'/'simple' as an ordinary name colliding with the qualifier keyword (C660)", () => {
    it("parses a typed local named 'simple' inside a UDF body (the corpus-motivating case)", () => {
      const script = parse("f(x) =>\n    float simple = x * 2.0\n    simple\n");
      const fn = script.body[0] as FuncDecl;
      const decl = fn.body[0] as Assignment;
      expect(decl.kind).toBe("Assignment");
      expect(decl.name).toBe("simple");
      expect(decl.typeHint).toBe("float");
      expect(fn.body[1]).toMatchObject({ kind: "ExprStmt", expr: { kind: "Identifier", name: "simple" } });
    });

    it("parses a typed local named 'series' (non-var, no leading qualifier ambiguity)", () => {
      const script = parse("float series = 5.0");
      const stmt = script.body[0] as Assignment;
      expect(stmt.name).toBe("series");
      expect(stmt.typeHint).toBe("float");
    });

    it("parses a typed local named 'simple' with no initializer (na desugar, C635 sibling form)", () => {
      const script = parse("float simple");
      const stmt = script.body[0] as Assignment;
      expect(stmt.name).toBe("simple");
      expect(stmt.typeHint).toBe("float");
      expect(stmt.value).toMatchObject({ kind: "NaLiteral" });
    });

    it("parses a bare 'var' declaration named 'simple' with no type hint ('var simple = 5')", () => {
      const script = parse("var simple = 5");
      const stmt = script.body[0] as VarDecl;
      expect(stmt.kind).toBe("VarDecl");
      expect(stmt.name).toBe("simple");
      expect(stmt.typeHint).toBeNull();
    });

    it("parses a bare 'var' declaration named 'series' with no type hint ('var series = 5')", () => {
      const script = parse("var series = 5");
      const stmt = script.body[0] as VarDecl;
      expect(stmt.name).toBe("series");
      expect(stmt.typeHint).toBeNull();
    });

    it("parses a typed 'var' declaration named 'simple' ('var float simple = 5.0')", () => {
      const script = parse("var float simple = 5.0");
      const stmt = script.body[0] as VarDecl;
      expect(stmt.name).toBe("simple");
      expect(stmt.typeHint).toBe("float");
    });

    it("does not regress the qualifier-prefixed var form ('var series float x = 1.0' still treats 'series' as a qualifier)", () => {
      const script = parse("var series float x = 1.0");
      const stmt = script.body[0] as VarDecl;
      expect(stmt.name).toBe("x");
      expect(stmt.typeHint).toBe("float");
    });

    it("parses a typed function parameter named 'simple' as a single param (not split in two)", () => {
      const script = parse("f(float simple) => simple * 2");
      const stmt = script.body[0] as FuncDecl;
      expect(stmt.params).toHaveLength(1);
      expect(stmt.params[0]).toMatchObject({ name: "simple", typeHint: "float" });
    });

    it("parses a qualifier+type function parameter named 'series' ('series float series')", () => {
      const script = parse("f(series float series) => series * 2");
      const stmt = script.body[0] as FuncDecl;
      expect(stmt.params).toHaveLength(1);
      expect(stmt.params[0]).toMatchObject({ name: "series", typeHint: "series float" });
    });

    it("parses a UDT field named 'simple' and reads it back through DotAccess", () => {
      const script = parse("type Foo\n    float simple\n");
      const typeDecl = script.body[0] as TypeDecl;
      expect(typeDecl.fields[0]).toMatchObject({ name: "simple", typeHint: "float" });

      const readBack = parse("x.simple").body[0] as ExprStmt;
      expect(readBack.expr).toMatchObject({ kind: "DotAccess", attr: "simple" });
    });

    it("still throws for a bare qualifier at statement level with no type ('series x = 1', no regression)", () => {
      expect(() => parse("series x = 1")).toThrow(ParseError);
    });
  });

  // C766: 'string'/'series'/'simple'과 우연히 같은 이름 문제(C660)를 STRATEGY/INDICATOR/LIBRARY/TYPE/
  // METHOD 등 나머지 지시어/선언 키워드로 대칭 확장 — wild `string strategy = input.string(...)` 실측
  // (corpus_scan v2 pure_gap 'other' 재분류, next_hint(C765)). parsePrimary(term 위치)가 이미 이
  // 화이트리스트를 bare Identifier로 인정하는데, "TYPE name [= value]"(var 유무 무관) 신규 로컬 선언
  // lookahead만 IDENTIFIER/SERIES/SIMPLE로 좁게 막혀 있어 이름이 이 키워드와 겹치면 "TYPE"과 "name"이
  // 두 개의 무관한 문장으로 조용히 쪼개졌다(C212/C660과 동일한 침묵 오분할 클래스).
  describe("typed local declarations named after a directive/decl keyword (INDICATOR/STRATEGY/LIBRARY/TYPE/METHOD, C766)", () => {
    it.each(["indicator", "strategy", "library", "type", "method"])(
      "parses 'string %s = value' as a single typed Assignment, not a silent two-statement split",
      (kw) => {
        const script = parse(`string ${kw} = "x"`);
        expect(script.body).toHaveLength(1);
        const stmt = script.body[0] as Assignment;
        expect(stmt.kind).toBe("Assignment");
        expect(stmt.name).toBe(kw);
        expect(stmt.typeHint).toBe("string");
        expect(stmt.value).toMatchObject({ kind: "StringLiteral", value: "x" });
      },
    );

    it.each(["indicator", "strategy", "library", "type", "method"])(
      "parses 'var string %s = value' as a single VarDecl",
      (kw) => {
        const script = parse(`var string ${kw} = "x"`);
        expect(script.body).toHaveLength(1);
        const stmt = script.body[0] as VarDecl;
        expect(stmt.kind).toBe("VarDecl");
        expect(stmt.name).toBe(kw);
        expect(stmt.typeHint).toBe("string");
      },
    );

    it.each(["indicator", "strategy", "library", "type", "method"])(
      "parses 'var %s = value' (no type hint) as a single VarDecl",
      (kw) => {
        const script = parse(`var ${kw} = "x"`);
        expect(script.body).toHaveLength(1);
        const stmt = script.body[0] as VarDecl;
        expect(stmt.kind).toBe("VarDecl");
        expect(stmt.name).toBe(kw);
        expect(stmt.typeHint).toBeNull();
      },
    );

    it("parses 'string strategy' with no initializer (na desugar, C635 sibling form)", () => {
      const script = parse("string strategy");
      expect(script.body).toHaveLength(1);
      const stmt = script.body[0] as Assignment;
      expect(stmt.name).toBe("strategy");
      expect(stmt.typeHint).toBe("string");
      expect(stmt.value).toMatchObject({ kind: "NaLiteral" });
    });

    it("parses the exact wild shape ('string strategy = input.string(title = ..., defval = ...)')", () => {
      const script = parse(`string strategy = input.string(title = 'Strategy', defval = 'RSI')`);
      const stmt = script.body[0] as Assignment;
      expect(stmt.name).toBe("strategy");
      expect(stmt.typeHint).toBe("string");
      expect(stmt.value).toMatchObject({ kind: "CallExpr" });
    });

    it("still parses a plain typed local unaffected (no regression, 'string label = \"x\"' ordinary name)", () => {
      const script = parse(`string label = "x"`);
      const stmt = script.body[0] as Assignment;
      expect(stmt.name).toBe("label");
      expect(stmt.typeHint).toBe("string");
    });
  });

  // C262: `calcStats(float[] arr, int startIdx = 0) =>` 형태의 함수 파라미터 대괄호-접미
  // 배열 타입 shorthand(`array<float>`의 대체 표기) 신규 지원. 이전엔 parseFuncParam이
  // SERIES/SIMPLE 접두사와 'TYPE name' 2-토큰 형태만 처리해 `float[]`를 만나면 typeHint를
  // 못 만들고 다음 파라미터명 자리에서 `[`를 "expected IDENTIFIER ... got LBRACKET"으로
  // 거부했다(corpus 6개 파일, PROGRESS.md C261 next_hint 1순위). parseVarDecl(C213)이 이미 갖고
  // 있는 동일 4-토큰 lookahead(IDENTIFIER LBRACKET RBRACKET IDENTIFIER) + `array<TYPE>` 정규화를
  // parseFuncParam에 이식 -- pine2py parser.py _is_array_type_shorthand/
  // _consume_array_type_shorthand가 _parse_func_param에서도 동일하게 재사용됨을 소스 대조로 확인.
  it("parses 'f(float[] arr) => arr' with typeHint normalized to 'array<float>'", () => {
    const script = parse("f(float[] arr) => arr");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]).toMatchObject({ kind: "FuncParam", name: "arr", typeHint: "array<float>", default: null });
  });

  it("parses 'f(int[] xs) => xs' (different base type)", () => {
    const script = parse("f(int[] xs) => xs");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("array<int>");
    expect(stmt.params[0]!.name).toBe("xs");
  });

  it("parses a bracket-shorthand param followed by a defaulted plain param (the exact corpus shape)", () => {
    const script = parse("calcStats(float[] arr, int startIdx = 0) => arr");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params).toHaveLength(2);
    expect(stmt.params[0]).toMatchObject({ name: "arr", typeHint: "array<float>", default: null });
    expect(stmt.params[1]).toMatchObject({ name: "startIdx", typeHint: "int" });
    expect(stmt.params[1]!.default).toMatchObject({ kind: "NumberLiteral", value: 0 });
  });

  it("routes a method declaration's bracket-shorthand param through the same shared parseFuncParam", () => {
    const script = parse("method sum(string[] tags) => tags");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.kind).toBe("MethodDecl");
    expect(stmt.params[0]).toMatchObject({ name: "tags", typeHint: "array<string>" });
  });

  it("does not consume the bracket-type lookahead for an untyped param (no regression, 'f(x) => x')", () => {
    const script = parse("f(x) => x");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]).toMatchObject({ name: "x", typeHint: null });
  });

  it("does not consume the bracket-type lookahead for a plain 'TYPE name' param (no regression, 'f(float x) => x')", () => {
    const script = parse("f(float x) => x");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("float");
    expect(stmt.params[0]!.name).toBe("x");
  });

  // C314: "type"은 tokens.ts KEYWORDS에 TYPE 토큰으로 예약돼 있지만(UDT 선언 키워드), TV에서는
  // MA 종류 선택 등에 흔히 쓰이는 평범한 UDF 파라미터 이름이기도 하다(wild 최다 클러스터
  // 187/192건이 bare `type`, e.g. `ma(source, length, type) =>`). 파라미터 이름 자리는
  // dot-attr(KEYWORD_AS_ATTR)/UDT 필드명과 동일하게 항상 "이름 자리"로 확정된 문법 슬롯이라
  // 모호성 없이 동일한 완화를 재사용할 수 있다.
  it("accepts the reserved TYPE keyword token as a bare (no type-hint) param name", () => {
    const script = parse("ma(source, length, type) => type");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params.map((p) => p.name)).toEqual(["source", "length", "type"]);
    expect(stmt.params[2]!.typeHint).toBeNull();
  });

  it("accepts TYPE as the first (and only) bare param name", () => {
    const script = parse("variant(type) => type");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params).toHaveLength(1);
    expect(stmt.params[0]).toMatchObject({ name: "type", typeHint: null });
  });

  it("accepts TYPE as a param name after a single type-hint word ('string type')", () => {
    const script = parse("ma(string type, int length) => type");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]).toMatchObject({ name: "type", typeHint: "string" });
    expect(stmt.params[1]).toMatchObject({ name: "length", typeHint: "int" });
  });

  it("accepts TYPE as a param name after a qualifier + base type ('simple string type')", () => {
    const script = parse("oscCenter(simple string type) => type");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]).toMatchObject({ name: "type", typeHint: "simple string" });
  });

  it("accepts a defaulted TYPE param ('simple string type = \"rsi\"')", () => {
    const script = parse('oscillator(simple string type = "rsi", simple int length = 14) => type');
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.name).toBe("type");
    expect(stmt.params[0]!.typeHint).toBe("simple string");
    expect(stmt.params[0]!.default).toMatchObject({ kind: "StringLiteral", value: "rsi" });
  });

  it("routes a method declaration's bare TYPE param name through the same shared parseFuncParam", () => {
    const script = parse("method f(Point p, type) => p.x");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.kind).toBe("MethodDecl");
    expect(stmt.params.map((p) => p.name)).toEqual(["p", "type"]);
  });

  // C315: `array<float> arr`/`map<K,V> m` 제네릭 타입힌트 함수 파라미터 (wild 최다 클러스터
  // "parse: expected IDENTIFIER in function parameter, got LT", 166건 중 164건). 이전엔
  // parseFuncParam이 SERIES/SIMPLE 접두, 대괄호 shorthand, 'TYPE name' 2-토큰 형태만 처리해
  // "array" IDENTIFIER를 파라미터 이름으로 오소비한 뒤 '<'에서 다음 파라미터를 기대하다 실패했다.
  // UDT 필드 타입 자리(parseFieldTypeHint)가 이미 쓰는 동일 재귀 조립 헬퍼를 그대로 재사용.
  it("parses a single-arg generic type hint param 'array<float> arr'", () => {
    const script = parse("safe_array_get(array<float> arr, int idx) => arr.get(idx)");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]).toMatchObject({ kind: "FuncParam", name: "arr", typeHint: "array<float>", default: null });
    expect(stmt.params[1]).toMatchObject({ name: "idx", typeHint: "int" });
  });

  it("parses a two-arg generic type hint param 'map<string, float> m'", () => {
    const script = parse("f(map<string, float> m, string key) => m.get(key)");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("map<string, float>");
    expect(stmt.params[0]!.name).toBe("m");
  });

  it("parses a nested generic type hint param 'map<string, array<float>> m'", () => {
    const script = parse("f(map<string, array<float>> m) => m");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("map<string, array<float>>");
  });

  it("routes a method declaration's generic type hint param through the same shared parseFuncParam", () => {
    const script = parse("method flush(array<LabelledLine> this) => this");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.kind).toBe("MethodDecl");
    expect(stmt.params[0]!.typeHint).toBe("array<LabelledLine>");
  });

  it("parses a generic type hint param followed by a defaulted plain param (the exact corpus shape)", () => {
    const script = parse(
      "get_similar_trends(array<int> all_durations, array<bool> all_is_bullish, int min_similar = 3) => all_durations",
    );
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params).toHaveLength(3);
    expect(stmt.params[0]).toMatchObject({ name: "all_durations", typeHint: "array<int>" });
    expect(stmt.params[1]).toMatchObject({ name: "all_is_bullish", typeHint: "array<bool>" });
    expect(stmt.params[2]!.default).toMatchObject({ kind: "NumberLiteral", value: 3 });
  });

  // C315: 한정자+제네릭 조합 `series array<float> arr` (wild 1건).
  it("parses a qualifier + generic type hint combo 'series array<float> src'", () => {
    const script = parse("sinc_filter(series array<float> source, simple float length) => source");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("series array<float>");
    expect(stmt.params[0]!.name).toBe("source");
  });

  // C634: 한정자+대괄호-접미 배열 shorthand 조합 `series float[] arr`(위 C315 제네릭 조합의
  // bracket-shorthand 자매 폼, wild 7건 이상 — `profileDrawTwoSides(series int[] leftWidths) =>`/
  // `f(simple linefill[] arr) => array.size(arr)` 등). 위 C315 분기(제네릭)와 C486 분기(dotted)
  // 사이에 나란히 추가된 세 번째 typeHint 합성 규칙 — "qualifier array<base>" 동일 포맷.
  it("parses a qualifier + bracket-shorthand array param 'series int[] leftWidths'", () => {
    const script = parse("profileDrawTwoSides(series int[] leftWidths) => leftWidths");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("series array<int>");
    expect(stmt.params[0]!.name).toBe("leftWidths");
  });

  it("parses a qualifier + bracket-shorthand array param with a non-numeric base type 'simple linefill[] arr'", () => {
    const script = parse("f(simple linefill[] arr) => array.size(arr)");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("simple array<linefill>");
    expect(stmt.params[0]!.name).toBe("arr");
  });

  it("routes a method declaration's qualifier + bracket-shorthand param through the same shared parseFuncParam", () => {
    const script = parse("method probability(series float[] self, series int idx) => self.get(idx)");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.kind).toBe("MethodDecl");
    expect(stmt.params[0]).toMatchObject({ name: "self", typeHint: "series array<float>" });
    expect(stmt.params[1]).toMatchObject({ name: "idx", typeHint: "series int" });
  });

  // C315: v6 파라미터화 타입 wrapper 문법 `series<float>` === `series float` (wild 2건, export
  // UDF 시그니처). qualifier 바로 뒤 '<'는 항상 단일 타입 인자 하나를 감싸는 wrapper.
  it("parses the v6 qualified type-parameter wrapper 'series<float> src' as 'series float'", () => {
    const script = parse("calculate_ma(series<float> src, int slow_length = 30) => src");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]!.typeHint).toBe("series float");
    expect(stmt.params[0]!.name).toBe("src");
  });

  it("does not consume the generic-type lookahead for an untyped param (no regression, 'f(x) => x')", () => {
    const script = parse("f(x) => x");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]).toMatchObject({ name: "x", typeHint: null });
  });

  it("parses a UDF with no params", () => {
    const script = parse("f() => 1");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params).toHaveLength(0);
  });

  it("parses a UDF with multiple comma-separated params", () => {
    const script = parse("f(a, b, c) => a + b + c");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params.map((p) => p.name)).toEqual(["a", "b", "c"]);
  });

  it("does not mistake a bare function call for a function declaration", () => {
    const script = parse("f(x)");
    const stmt = script.body[0] as ExprStmt;
    expect(stmt.kind).toBe("ExprStmt");
    expect((stmt.expr as CallExpr).kind).toBe("CallExpr");
  });

  it("parses a UDF declaration followed by a statement calling it", () => {
    const script = parse(["double(x) => x * 2", "y = double(close)"].join("\n"));
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("FuncDecl");
    expect(script.body[1]!.kind).toBe("Assignment");
  });

  // ── 튜플 destructure ([a, b] = expr) ───────────────────────

  it("parses a tuple destructure with two targets", () => {
    const script = parse("[a, b] = f()");
    const stmt = script.body[0] as TupleDestructure;
    expect(stmt.kind).toBe("TupleDestructure");
    expect(stmt.names).toEqual(["a", "b"]);
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("parses a tuple destructure with three targets", () => {
    const script = parse("[a, b, c] = f()");
    const stmt = script.body[0] as TupleDestructure;
    expect(stmt.names).toEqual(["a", "b", "c"]);
  });

  // wild2 코퍼스 실측(C661): `[a, b]\n    = f()`류 — '='를 다음 줄 맨 앞에 두는 정렬 스타일
  // (request.security/request.security_lower_tf 다중 반환 대입에서 다수 확인). lexer의
  // leading-ASSIGN continuation(C661)이 NEWLINE/INDENT를 흡수해 단일 문장으로 병합돼야 한다.
  it("parses a tuple destructure whose '=' is wrapped onto the next (indented) line", () => {
    const script = parse("[a, b]\n    = f()");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as TupleDestructure;
    expect(stmt.kind).toBe("TupleDestructure");
    expect(stmt.names).toEqual(["a", "b"]);
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  // ── 튜플 디스트럭처 대상이 예약 키워드인 경우(C726, wild
  // `[_time, indicator, price, signal] = request.security(...)` 9건) ──────
  // parsePrimary(term 위치)가 이미 bare Identifier로 허용해둔 예약어 화이트리스트
  // (INDICATOR/STRATEGY/LIBRARY/TYPE/SERIES/SIMPLE/METHOD)를 이 자리에도 대칭 확장한다 —
  // 일반 '=' 대입 대상은 이미 이 이름들을 자유롭게 쓸 수 있었는데 튜플 디스트럭처만 IDENTIFIER
  // 토큰으로 좁게 막혀 있던 비대칭이었다.
  describe("tuple destructure targets that are reserved keywords (C726)", () => {
    it.each(["indicator", "strategy", "library", "type", "series", "simple", "method"])(
      "parses '%s' as a tuple destructure target name",
      (kw) => {
        const script = parse(`[${kw}, x] = f()`);
        const stmt = script.body[0] as TupleDestructure;
        expect(stmt.kind).toBe("TupleDestructure");
        expect(stmt.names).toEqual([kw, "x"]);
      },
    );

    it("parses the exact wild shape ([_time, indicator, price, signal] = request.security(...))", () => {
      const script = parse("[_time, indicator, price, signal] = request.security(sym, tf, expr)");
      const stmt = script.body[0] as TupleDestructure;
      expect(stmt.kind).toBe("TupleDestructure");
      expect(stmt.names).toEqual(["_time", "indicator", "price", "signal"]);
      expect(stmt.value).toMatchObject({ kind: "CallExpr" });
    });

    it("parses a reserved keyword in the FIRST target position, not just a later one", () => {
      const script = parse("[method, x, y] = f()");
      const stmt = script.body[0] as TupleDestructure;
      expect(stmt.names).toEqual(["method", "x", "y"]);
    });

    it("parses two different reserved keywords in the same tuple destructure", () => {
      const script = parse("[type, method] = f()");
      const stmt = script.body[0] as TupleDestructure;
      expect(stmt.names).toEqual(["type", "method"]);
    });

    it("still throws a ParseError for a genuinely non-name token in target position (does not over-widen acceptance)", () => {
      expect(() => parse("[1, x] = f()")).toThrow(ParseError);
    });

    it("still parses a plain all-IDENTIFIER tuple destructure unaffected (no regression)", () => {
      const script = parse("[a, b] = f()");
      const stmt = script.body[0] as TupleDestructure;
      expect(stmt.names).toEqual(["a", "b"]);
    });
  });

  // ── 튜플 표현식([a, b] — '=' 없이 값 위치, UDF 마지막 문장의 튜플 반환용) ──────

  it("parses a bracketed expression with no trailing '=' as a TupleExpr, not a destructure", () => {
    const script = parse("[a, b]");
    const stmt = script.body[0] as ExprStmt;
    expect(stmt.kind).toBe("ExprStmt");
    expect(stmt.expr.kind).toBe("TupleExpr");
    expect((stmt.expr as TupleExpr).elements).toHaveLength(2);
  });

  it("parses arbitrary expressions (not just identifiers) as TupleExpr elements", () => {
    const script = parse("[x + 1, x - 1]");
    const stmt = script.body[0] as ExprStmt;
    const tuple = stmt.expr as TupleExpr;
    expect(tuple.elements.map((e) => e.kind)).toEqual(["BinOp", "BinOp"]);
  });

  it("parses a UDF body whose last statement is a tuple literal", () => {
    const script = parse(["f(x, y) =>", "    s = x + y", "    d = x - y", "    [s, d]"].join("\n"));
    const stmt = script.body[0] as FuncDecl;
    const last = stmt.body[stmt.body.length - 1] as ExprStmt;
    expect(last.expr.kind).toBe("TupleExpr");
    expect((last.expr as TupleExpr).elements).toHaveLength(2);
  });

  // ── 히스토리 참조(postfix series[n]) ───────────────────────

  it("parses a postfix history reference on a bar series identifier", () => {
    const script = parse("x = close[1]");
    const stmt = script.body[0] as Assignment;
    const idx = stmt.value as IndexAccess;
    expect(idx.kind).toBe("IndexAccess");
    expect(idx.obj).toMatchObject({ kind: "Identifier", name: "close" });
    expect(idx.index).toMatchObject({ kind: "NumberLiteral", value: 1 });
  });

  it("parses a postfix history reference on a plain identifier", () => {
    const script = parse("y = acc[2]");
    const stmt = script.body[0] as Assignment;
    const idx = stmt.value as IndexAccess;
    expect(idx.obj).toMatchObject({ kind: "Identifier", name: "acc" });
    expect(idx.index).toMatchObject({ kind: "NumberLiteral", value: 2 });
  });

  it("does not confuse a statement-leading tuple destructure with postfix indexing", () => {
    const script = parse("[a, b] = f()\nc = a[1]");
    expect(script.body[0]!.kind).toBe("TupleDestructure");
    const stmt = script.body[1] as Assignment;
    expect((stmt.value as IndexAccess).kind).toBe("IndexAccess");
  });

  it("parses a chained history reference following a binary operand", () => {
    const script = parse("x = close[1] + close[2]");
    const stmt = script.body[0] as Assignment;
    const bin = stmt.value as BinOp;
    expect((bin.left as IndexAccess).kind).toBe("IndexAccess");
    expect((bin.right as IndexAccess).kind).toBe("IndexAccess");
  });

  it("does not swallow a statement-leading tuple destructure as postfix indexing of a preceding switch-expression (C459)", () => {
    const script = parse(
      ["x = switch y", '    "a" => "1"', '    "b" => "2"', "", "[a, b, c] = f()"].join("\n"),
    );
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("Assignment");
    expect((script.body[0] as Assignment).value.kind).toBe("SwitchStmt");
    const tuple = script.body[1] as TupleDestructure;
    expect(tuple.kind).toBe("TupleDestructure");
    expect(tuple.names).toEqual(["a", "b", "c"]);
  });

  it("does not swallow a statement-leading tuple destructure as postfix indexing of a preceding if-expression (C459)", () => {
    const script = parse(["x = if y > 0", "    1.0", "else", "    2.0", "", "[a, b] = f()"].join("\n"));
    expect(script.body).toHaveLength(2);
    expect((script.body[0] as Assignment).value.kind).toBe("IfStmt");
    expect((script.body[1] as TupleDestructure).kind).toBe("TupleDestructure");
  });

  // ── 제어문-식(if/for/while/switch as expression) — VarDecl/Assignment 값 위치 ──

  it("parses 'x = if cond ... else ...' with the RHS as an IfStmt expression node", () => {
    const script = parse(["x = if close > open", "    1.0", "else", "    0.0"].join("\n"));
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe("=");
    expect(stmt.value.kind).toBe("IfStmt");
    const ifExpr = stmt.value as IfStmt;
    expect(ifExpr.thenBody).toHaveLength(1);
    expect(ifExpr.elseBody).toHaveLength(1);
  });

  it("parses 'x := if cond ... else if ... else ...' (reassignment, elif chain) as an IfStmt expression", () => {
    const script = parse(
      ["x := if close > open", "    1.0", "else if close < open", "    -1.0", "else", "    0.0"].join("\n"),
    );
    const stmt = script.body[0] as Assignment;
    expect(stmt.operator).toBe(":=");
    const ifExpr = stmt.value as IfStmt;
    expect(ifExpr.kind).toBe("IfStmt");
    expect(ifExpr.elifClauses).toHaveLength(1);
  });

  it("parses 'x = switch ... => ...' with the RHS as a SwitchStmt expression node", () => {
    const script = parse(["x = switch", "    close > open => 1.0", "    => 0.0"].join("\n"));
    const stmt = script.body[0] as Assignment;
    expect(stmt.value.kind).toBe("SwitchStmt");
    expect((stmt.value as SwitchStmt).cases).toHaveLength(2);
  });

  it("parses 'x = for i = 1 to 3 ...' with the RHS as a ForStmt expression node", () => {
    const script = parse(["x = for i = 1 to 3", "    i * 2"].join("\n"));
    const stmt = script.body[0] as Assignment;
    expect(stmt.value.kind).toBe("ForStmt");
    expect((stmt.value as ForStmt).varName).toBe("i");
  });

  it("parses 'x = while cond ...' with the RHS as a WhileStmt expression node", () => {
    const script = parse(["x = while close > open", "    1.0"].join("\n"));
    const stmt = script.body[0] as Assignment;
    expect(stmt.value.kind).toBe("WhileStmt");
  });

  it("parses 'var float x = if cond ... else ...' with the RHS as an IfStmt expression node", () => {
    const script = parse(["var float x = if close > open", "    close", "else", "    na"].join("\n"));
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.value.kind).toBe("IfStmt");
  });

  it("still parses a statement-position 'if' as a plain IfStmt (no assignment involved)", () => {
    const script = parse(["if close > open", "    x = 1.0"].join("\n"));
    expect(script.body[0]!.kind).toBe("IfStmt");
  });

  // ── Bool 리터럴(true/false) ──────────────────────────────

  it("parses 'true' as a BoolLiteral expression", () => {
    const script = parse("x = true");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "BoolLiteral", value: true });
  });

  it("parses 'false' as a BoolLiteral expression", () => {
    const script = parse("x = false");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "BoolLiteral", value: false });
  });

  it("parses bool literals combined with 'and'/'not'", () => {
    const script = parse("x = true and not false");
    const stmt = script.body[0] as Assignment;
    const bin = stmt.value as BinOp;
    expect(bin.op).toBe("and");
    expect(bin.left).toMatchObject({ kind: "BoolLiteral", value: true });
    const unary = bin.right as UnaryOp;
    expect(unary.op).toBe("not");
    expect(unary.operand).toMatchObject({ kind: "BoolLiteral", value: false });
  });

  it("parses a bool literal as a ternary condition", () => {
    const script = parse("x = true ? close : open");
    const stmt = script.body[0] as Assignment;
    const ternary = stmt.value as TernaryOp;
    expect(ternary.condition).toMatchObject({ kind: "BoolLiteral", value: true });
  });

  it("parses a bool literal as an if-statement condition", () => {
    const script = parse(["if true", "    x := 1.0", "else", "    x := 0.0"].join("\n"));
    const stmt = script.body[0] as IfStmt;
    expect(stmt.condition).toMatchObject({ kind: "BoolLiteral", value: true });
  });

  it("parses a bool literal as a var declaration's initial value", () => {
    const script = parse("var bool flag = false");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.value).toMatchObject({ kind: "BoolLiteral", value: false });
  });

  // ── Color 리터럴(#RRGGBB/#RRGGBBAA, C226) ──────────────────────────────
  // lexer.ts readColor는 이미 COLOR 토큰을 만들지만(lexer.test.ts에서 검증됨) parsePrimary가
  // 소비하지 않아 지금까지 전부 "예상치 못한 토큰 COLOR"로 ParseError였다(corpus 22건 실측).

  it("parses a #RRGGBB literal as a ColorLiteral expression", () => {
    const script = parse("x = #FF0000");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "ColorLiteral", value: "#FF0000" });
  });

  it("parses a #RRGGBBAA literal (alpha channel) and preserves case as-is", () => {
    const script = parse("x = #ff00ffAA");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "ColorLiteral", value: "#ff00ffAA" });
  });

  it("parses a color literal as a ternary branch", () => {
    const script = parse("x = close > open ? #00FF00 : #FF0000");
    const stmt = script.body[0] as Assignment;
    const ternary = stmt.value as TernaryOp;
    expect(ternary.trueExpr).toMatchObject({ kind: "ColorLiteral", value: "#00FF00" });
    expect(ternary.falseExpr).toMatchObject({ kind: "ColorLiteral", value: "#FF0000" });
  });

  it("parses a color literal as a call keyword argument (e.g. plot(x, color=#FF0000))", () => {
    const script = parse("plot(x, color=#FF0000)");
    const stmt = script.body[0] as ExprStmt;
    const call = stmt.expr as CallExpr;
    expect(call.kwargs[0]!.name).toBe("color");
    expect(call.kwargs[0]!.value).toMatchObject({ kind: "ColorLiteral", value: "#FF0000" });
  });

  it("parses a color literal as a var declaration's initial value", () => {
    const script = parse("var color c = #123456");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.value).toMatchObject({ kind: "ColorLiteral", value: "#123456" });
  });
});

describe("Parser UDT (type declarations + field assignment, slice 1)", () => {
  it("parses a type declaration with a single field and no default", () => {
    const script = parse(["type Bar", "    float x"].join("\n"));
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.kind).toBe("TypeDecl");
    expect(stmt.name).toBe("Bar");
    expect(stmt.fields).toHaveLength(1);
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "x", typeHint: "float", default: null });
  });

  it("parses a type declaration with multiple fields across the five scalar types, some with defaults", () => {
    const script = parse(
      ["type Point", "    float x = 1.0", "    int n", "    bool flag = true", "    string label = \"p\"", "    color c"].join(
        "\n",
      ),
    );
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields.map((f) => f.name)).toEqual(["x", "n", "flag", "label", "c"]);
    expect(stmt.fields.map((f) => f.typeHint)).toEqual(["float", "int", "bool", "string", "color"]);
    expect(stmt.fields[0]!.default).toMatchObject({ kind: "NumberLiteral", value: 1 });
    expect(stmt.fields[1]!.default).toBeNull();
    expect(stmt.fields[2]!.default).toMatchObject({ kind: "BoolLiteral", value: true });
    expect(stmt.fields[3]!.default).toMatchObject({ kind: "StringLiteral", value: "p" });
    expect(stmt.fields[4]!.default).toBeNull();
  });

  it("parses a type declaration with zero fields", () => {
    const script = parse("type Empty");
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields).toEqual([]);
  });

  it("parses a field default as an arbitrary expression, not just a literal", () => {
    const script = parse(["type Bar", "    float x = 1 + 2"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    const bin = stmt.fields[0]!.default as BinOp;
    expect(bin.kind).toBe("BinOp");
    expect(bin.op).toBe("+");
  });

  it("parses a field default that is the 'na' literal", () => {
    const script = parse(["type Bar", "    string label = na"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]!.default).toMatchObject({ kind: "NaLiteral" });
  });

  it("parses 'TypeName.new(...)' as an ordinary CallExpr over a DotAccess callee", () => {
    const script = parse("p = Bar.new(1.0)");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "DotAccess", attr: "new" });
    expect(call.args).toHaveLength(1);
  });

  it("parses 'obj.field := value' as a FieldAssignment, not a plain Assignment", () => {
    const script = parse("p.x := 5.0");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as FieldAssignment;
    expect(stmt.kind).toBe("FieldAssignment");
    expect(stmt.object).toMatchObject({ kind: "Identifier", name: "p" });
    expect(stmt.field).toBe("x");
    expect(stmt.value).toMatchObject({ kind: "NumberLiteral", value: 5 });
  });

  it("rejects 'obj.field = value' (plain '=') as a field target — parses as an ExprStmt/comparison-less DotAccess instead of a FieldAssignment", () => {
    // Pine only allows ':=' for field mutation. Since parseAssignmentOrExpr only special-cases
    // DotAccess targets on WALRUS, a bare '=' after a dot access falls through — the '=' is left
    // unconsumed and the surrounding statement parse fails downstream (proves '=' isn't silently
    // accepted as a field assignment operator).
    expect(() => parse("p.x = 5.0")).toThrow();
  });

  it("parses a chained dot-access field target at the parser level (analyzer narrows nested access later)", () => {
    const script = parse("a.b.x := 1.0");
    const stmt = script.body[0] as FieldAssignment;
    expect(stmt.kind).toBe("FieldAssignment");
    expect(stmt.object).toMatchObject({ kind: "DotAccess", attr: "b" });
    expect(stmt.field).toBe("x");
  });

  it("parses a bare field read 'obj.field' inside a larger expression", () => {
    const script = parse("y = p.x + 1");
    const stmt = script.body[0] as Assignment;
    const bin = stmt.value as BinOp;
    expect(bin.left).toMatchObject({ kind: "DotAccess", attr: "x" });
  });
});

describe("Parser TYPE keyword as a bare statement-start identifier ('type = expr', C480, wild 42건)", () => {
  // C314가 이미 "type"을 UDF/method 파라미터 이름 자리에서 bare Identifier로 허용했지만,
  // 문장 시작 위치(parseStatement)는 여전히 TYPE 토큰을 보자마자 무조건 parseTypeDecl로
  // 커밋해 `type = input.string(...)`(TV의 흔한 변수명 관용구)가 항상 "expected IDENTIFIER
  // in type declaration, got ASSIGN"로 실패했다. 1토큰 lookahead(다음 토큰이 IDENTIFIER인지)로
  // 실제 UDT 선언과 구분한다.
  it("parses 'type = expr' as a plain Assignment, not a TypeDecl", () => {
    const script = parse('type = input.string("Traditional", "Pivot Type")');
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.name).toBe("type");
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("parses 'type := expr' as a reassignment of the bare 'type' identifier", () => {
    const script = parse('type = "A"\ntype := "B"\n');
    expect(script.body).toHaveLength(2);
    const reassign = script.body[1] as Assignment;
    expect(reassign.kind).toBe("Assignment");
    expect(reassign.name).toBe("type");
    expect(reassign.value).toMatchObject({ kind: "StringLiteral", value: "B" });
  });

  it("reads a bare 'type' identifier in a later expression after 'type = expr'", () => {
    const script = parse('type = "CE"\nlabel = type == "CE" ? 1 : 2\n');
    const stmt = script.body[1] as Assignment;
    const ternary = stmt.value as TernaryOp;
    expect(ternary.kind).toBe("TernaryOp");
    expect(ternary.condition).toMatchObject({ kind: "BinOp", op: "==" });
    expect((ternary.condition as BinOp).left).toMatchObject({ kind: "Identifier", name: "type" });
  });

  it("still parses a real 'type Name' UDT declaration unambiguously (lookahead does not regress it)", () => {
    const script = parse(["type Bar", "    float x"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.kind).toBe("TypeDecl");
    expect(stmt.name).toBe("Bar");
  });

  it("still parses 'export type Foo' after the lookahead change", () => {
    const script = parse("export type Foo\n    float value\n");
    expect((script.body[0] as TypeDecl).kind).toBe("TypeDecl");
  });
});

describe("Parser METHOD keyword as a bare identifier (C691, wild LuxAlgo cluster)", () => {
  // C691: "method"는 tokens.ts KEYWORDS에 METHOD 토큰으로 예약돼 있지만(method 선언 키워드),
  // TV에서는 `methodRiskIndicator(method) => if method == 'Average' ...`처럼 UDF 파라미터로
  // 받아 본문에서 읽는 흔한 이름이기도 하다(wild "예상치 못한 토큰 METHOD" 클러스터 16건).
  // parseFuncParam은 이미 KEYWORD_AS_ATTR로 파라미터 "이름" 자리를 허용해뒀지만, 그 값을 본문
  // 표현식(비교/삼항 등) 안에서 다시 읽는 term 위치는 parsePrimary 화이트리스트에 METHOD가
  // 없어 항상 "예상치 못한 토큰 METHOD"였다.
  it("reads a bare 'method' param back inside an if condition (the exact wild shape)", () => {
    const script = parse(["f(method) =>", "    if method == 'Average'", "        1", "    else", "        2"].join("\n"));
    const stmt = script.body[0] as FuncDecl;
    const ifStmt = stmt.body[0] as IfStmt;
    expect(ifStmt.condition).toMatchObject({ kind: "BinOp", op: "==" });
    expect((ifStmt.condition as BinOp).left).toMatchObject({ kind: "Identifier", name: "method" });
  });

  it("reads a bare 'method' identifier in a ternary", () => {
    const script = parse("f(method) => method == 'A' ? 1 : 2");
    const stmt = script.body[0] as FuncDecl;
    const exprStmt = stmt.body[0] as ExprStmt;
    const ternary = exprStmt.expr as TernaryOp;
    expect((ternary.condition as BinOp).left).toMatchObject({ kind: "Identifier", name: "method" });
  });

  // C691 (2번째 축, LuxAlgo 실전 관용구): 문장 시작 위치는 여전히 METHOD 토큰을 보자마자 무조건
  // parseMethodDecl로 커밋했다 -- `method = input.string(...)`(TV의 흔한 변수명 관용구)가 항상
  // "expected IDENTIFIER in method declaration, got ASSIGN"였다. TYPE(C480)과 동일한 1토큰
  // lookahead(다음 토큰이 IDENTIFIER인지)로 실제 method 선언과 구분한다.
  it("parses 'method = expr' as a plain Assignment, not a MethodDecl", () => {
    const script = parse("method = input.string('Atr', 'Interval Size Method')");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.name).toBe("method");
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("reads a bare 'method' identifier in a later expression after 'method = expr'", () => {
    const script = parse("method = 'Atr'\nlabel = method == 'Atr' ? 1 : 2\n");
    const stmt = script.body[1] as Assignment;
    const ternary = stmt.value as TernaryOp;
    expect((ternary.condition as BinOp).left).toMatchObject({ kind: "Identifier", name: "method" });
  });

  it("still parses a real 'method name(params) => body' MethodDecl unambiguously (lookahead does not regress it)", () => {
    const script = parse("method f(Point p) => p.x");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.kind).toBe("MethodDecl");
    expect(stmt.name).toBe("f");
  });
});

describe("Parser UDT field names that are reserved keywords (KEYWORD_AS_ATTR reused at field-name position, C263)", () => {
  it.each(["var", "varip", "type", "enum", "method", "import", "export", "if", "for", "while", "switch"])(
    "parses '%s' as a field name in a type declaration",
    (kw) => {
      const script = parse(["type Signal", `    float ${kw} = 0.0`].join("\n"));
      const stmt = script.body[0] as TypeDecl;
      expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: kw, typeHint: "float" });
    },
  );

  it("parses multiple keyword field names in the same type declaration", () => {
    const script = parse(
      ["type Signal", "    float var = 0.0", "    string type = \"none\"", "    float switch = 1.0"].join("\n"),
    );
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields.map((f) => f.name)).toEqual(["var", "type", "switch"]);
  });

  it("still requires an identifier or keyword field name for a generic type — a bare '=' with no name at all fails (C725: a single bare-identifier type slot like 'float = 0.0' is no longer this case — see the implicit-type-hint describe block below, since 'float' is a plain identifier, not a reserved keyword, in this lexer)", () => {
    expect(() => parse(["type Signal", "    array<float> = 0.0"].join("\n"))).toThrow();
  });

  it("parses a keyword field name read via 'obj.field' (already covered by DotAccess, sanity check alongside declaration)", () => {
    const script = parse(["type Signal", "    float var = 0.0"].join("\n") + "\ny = sig.var + 1");
    const assign = script.body[1] as Assignment;
    const bin = assign.value as BinOp;
    expect(bin.left).toMatchObject({ kind: "DotAccess", attr: "var" });
  });

  it("parses a keyword field name written via 'obj.field := value'", () => {
    const script = parse("sig.var := 5.0");
    const stmt = script.body[0] as FieldAssignment;
    expect(stmt.kind).toBe("FieldAssignment");
    expect(stmt.field).toBe("var");
  });
});

describe("Parser call keyword arguments ('name=value', UDT constructor kwargs slice, C129)", () => {
  it("parses a single keyword argument into kwargs, leaving args empty", () => {
    const script = parse("p = Bar.new(x=1.0)");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.args).toEqual([]);
    expect(call.kwargs).toHaveLength(1);
    expect(call.kwargs[0]!.name).toBe("x");
    expect(call.kwargs[0]!.value).toMatchObject({ kind: "NumberLiteral", value: 1 });
  });

  it("parses multiple keyword arguments in source order", () => {
    const script = parse('p = Bar.new(x=1.0, label="a", flag=true)');
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.args).toEqual([]);
    expect(call.kwargs.map((k) => k.name)).toEqual(["x", "label", "flag"]);
    expect(call.kwargs[1]!.value).toMatchObject({ kind: "StringLiteral", value: "a" });
    expect(call.kwargs[2]!.value).toMatchObject({ kind: "BoolLiteral", value: true });
  });

  it("parses mixed positional and keyword arguments into their respective arrays", () => {
    const script = parse("p = Bar.new(10.0, 20, label=\"mixed\")");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.args).toHaveLength(2);
    expect(call.args[0]).toMatchObject({ kind: "NumberLiteral", value: 10 });
    expect(call.args[1]).toMatchObject({ kind: "NumberLiteral", value: 20 });
    expect(call.kwargs).toHaveLength(1);
    expect(call.kwargs[0]).toMatchObject({ name: "label" });
  });

  it("distinguishes 'name=value' (keyword arg) from 'name==value' (equality comparison, stays positional)", () => {
    const script = parse("p = Bar.new(x==1.0)");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.kwargs).toEqual([]);
    expect(call.args).toHaveLength(1);
    expect(call.args[0]).toMatchObject({ kind: "BinOp", op: "==" });
  });

  it("records line/col on a CallKwarg pointing at the keyword identifier", () => {
    const script = parse("p = Bar.new(x=1.0)");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.kwargs[0]!.line).toBe(1);
    // "p = Bar.new(" is 12 chars (1-indexed columns), so 'x' starts at col 13
    expect(call.kwargs[0]!.col).toBe(13);
  });

  it("parses a keyword argument value as an arbitrary expression, not just a literal", () => {
    const script = parse("p = Bar.new(x=1.0 + close)");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.kwargs[0]!.value).toMatchObject({ kind: "BinOp", op: "+" });
  });

  it("parses call-argument keywords generically (not gated to '.new()' at the parser level — analyzer restricts elsewhere)", () => {
    const script = parse("y = nz(close, replacement=0.0)");
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.args).toHaveLength(1);
    expect(call.kwargs).toHaveLength(1);
    expect(call.kwargs[0]!.name).toBe("replacement");
  });

  it("parses a call with only keyword arguments and an empty args array", () => {
    const script = parse('p = Bar.new(x=1.0, n=2)');
    const stmt = script.body[0] as Assignment;
    const call = stmt.value as CallExpr;
    expect(call.args).toEqual([]);
    expect(call.kwargs).toHaveLength(2);
  });

  // C313: "series"는 tokens.ts KEYWORDS에 SERIES 토큰으로 예약돼 있지만(type qualifier), TV
  // plot()/plotshape()/plotchar() 등의 실제 첫 위치 인자 이름이기도 해 kwarg 이름 자리(`=' 직전)
  // 에서는 IDENTIFIER와 동일하게 받아들여야 한다(wild 최다 클러스터 331/339건이 이 폼).
  it("accepts the reserved SERIES keyword token as a kwarg name ('series=value')", () => {
    const script = parse("plot(series=close)");
    const stmt = script.body[0] as ExprStmt;
    const call = stmt.expr as CallExpr;
    expect(call.args).toEqual([]);
    expect(call.kwargs).toHaveLength(1);
    expect(call.kwargs[0]!.name).toBe("series");
    expect(call.kwargs[0]!.value).toMatchObject({ kind: "Identifier", name: "close" });
  });

  it("still parses a bare 'series' (no '=') as a type-qualifier keyword elsewhere, not a kwarg name", () => {
    const script = parse("series float x = close");
    expect(script.body).toHaveLength(1);
    expect(script.body[0]).toMatchObject({ kind: "Assignment", name: "x" });
  });
});

describe("Parser UDT generic field type (array<T>/map<K,V>, slice, C126)", () => {
  it("parses a single-arg generic field type 'array<float>' as a composed string", () => {
    const script = parse(["type Basket", "    array<float> prices"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "prices", typeHint: "array<float>" });
  });

  it("parses a two-arg generic field type 'map<string, float>' as a composed string", () => {
    const script = parse(["type Basket", "    map<string, float> tags"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "tags", typeHint: "map<string, float>" });
  });

  it("parses multiple generic fields alongside scalar fields in one type declaration", () => {
    const script = parse(
      ["type Basket", "    array<float> prices", "    map<string, int> counts", "    float label = 0.0"].join("\n"),
    );
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields.map((f) => f.typeHint)).toEqual(["array<float>", "map<string, int>", "float"]);
  });

  it("recursively composes a nested generic field type string at the parser level ('map<string, array<float>>')", () => {
    // The parser itself has no notion of "supported nesting depth" — it just recurses on '<'.
    // Rejecting deeper nesting (if desired) is an analyzer-level concern (isUdtFieldTypeAllowed).
    const script = parse(["type Basket", "    map<string, array<float>> grouped"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]!.typeHint).toBe("map<string, array<float>>");
  });

  it("captures the field's line/col from the start of the generic type hint, not the field name", () => {
    const script = parse(["type Basket", "    array<float> prices"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]!.line).toBe(2);
  });

  it("parses a field name immediately following a generic type's closing '>' with no extra whitespace handling needed", () => {
    const script = parse(["type Basket", "    array<float> prices", "    map<string, float> tags"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields.map((f) => f.name)).toEqual(["prices", "tags"]);
  });

  it("throws when a generic field type is missing its closing '>'", () => {
    expect(() => parse(["type Basket", "    array<float prices"].join("\n"))).toThrow();
  });

  it("parses a generic field type with a default value expression", () => {
    const script = parse(["type Basket", "    array<float> prices = array.new<float>()"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]!.typeHint).toBe("array<float>");
    expect(stmt.fields[0]!.default).not.toBeNull();
  });
});

describe("Parser UDT field bracket-suffix array type shorthand ('TYPE[] name', C318, wild 106건)", () => {
  // `line[] ln_handle` 등 -- `array<TYPE>`의 대체 표기. parseVarDecl(C213)/parseFuncParam(C262/C315)은
  // 이미 지원하지만 parseTypeField만 빠져 있던 갭(wild 최다 UDT 필드 파서 에러 클러스터).
  it("parses 'float[] prices' normalized to 'array<float>'", () => {
    const script = parse(["type Basket", "    float[] prices"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "prices", typeHint: "array<float>", default: null });
  });

  it("parses a drawing handle array field 'line[] ln_handle' normalized to 'array<line>'", () => {
    const script = parse(["type Zone", "    line[] ln_handle"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "ln_handle", typeHint: "array<line>" });
  });

  it("parses a UDT-typed array field 'Foo[] items' normalized to 'array<Foo>' (forward/self-ref allowed at parser level)", () => {
    const script = parse(["type Basket", "    Foo[] items"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "items", typeHint: "array<Foo>" });
  });

  it("parses multiple bracket-shorthand fields alongside scalar and generic fields in one type declaration", () => {
    const script = parse(
      ["type Zone", "    line[] ln_handle", "    label[] ln_tag", "    array<float> prices", "    float top"].join(
        "\n",
      ),
    );
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields.map((f) => f.typeHint)).toEqual(["array<line>", "array<label>", "array<float>", "float"]);
  });

  it("parses a bracket-shorthand field with a default value expression", () => {
    const script = parse(["type Basket", "    float[] prices = array.new_float(0)"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]!.typeHint).toBe("array<float>");
    expect(stmt.fields[0]!.default).not.toBeNull();
  });

  it("parses a bracket-shorthand field name that is a reserved keyword (KEYWORD_AS_ATTR, C263 precedent)", () => {
    const script = parse(["type Basket", "    float[] type"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ name: "type", typeHint: "array<float>" });
  });

  it("captures the field's line/col from the start of the bracket-shorthand type hint, not the field name", () => {
    const script = parse(["type Basket", "    float[] prices"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]!.line).toBe(2);
  });
});

// C486: 점 접근 타입명(`chart.point`) — wild "expected IDENTIFIER in type field ..., got DOT" 클러스터
// (33건, corpus_scan top-20). pine2py parser.py _parse_type_expression에 이 dot-chain while 루프가
// 이미 존재하지만(literal-port 대상), 그 함수를 호출하는 _parse_type_field 자신은 제네릭('<') 없는
// 필드에서 이 루프에 도달하는 경로가 없어(첫 토큰 1개만 소비) chart.point 필드를 만나면 DOT를
// 못 삼키고 다음 필드 파싱에서 크래시한다(python 직접 실행으로 확인 — pine2py 자신도 이 정확한
// 문법을 못 파싱, 오라클 구조적 불가). chart.point는 TV 공식 문서화된 실존 내장 타입이라 필드 위치
// 허용 자체는 의심할 근거가 없어(DIVERGENCES 등재) parseFieldTypeHint에 dot-chain을 hand-verified로
// 추가했다 — 다른 호출부(array<T> 제네릭 인자/qualified 함수 매개변수)에도 부작용 없이 확장된다.
describe("Parser UDT field dotted type name ('chart.point', C486, wild 33건)", () => {
  it("parses a bare 'chart.point' field type as the composed string 'chart.point'", () => {
    const script = parse(["type PointPair", "    chart.point firstPoint"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "firstPoint", typeHint: "chart.point", default: null });
  });

  it("parses two 'chart.point' fields in the same type declaration", () => {
    const script = parse(["type PointPair", "    chart.point firstPoint", "    chart.point secondPoint"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields.map((f) => f.typeHint)).toEqual(["chart.point", "chart.point"]);
  });

  it("parses 'chart.point[] pPC' (dotted type + bracket-shorthand array) normalized to 'array<chart.point>'", () => {
    const script = parse(["type Tvp", "    chart.point[] pPC"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "pPC", typeHint: "array<chart.point>" });
  });

  it("parses 'array<chart.point>' as a generic field type (dotted type as a generic argument)", () => {
    const script = parse(["type Tvp", "    array<chart.point> pPC"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "pPC", typeHint: "array<chart.point>" });
  });

  it("parses a 'chart.point' field with a default value expression", () => {
    const script = parse(["type PointPair", "    chart.point firstPoint = chart.point.new(bar_index, bar_index, close)"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]!.typeHint).toBe("chart.point");
    expect(stmt.fields[0]!.default).not.toBeNull();
  });

  it("parses a 'chart.point' function parameter type ('f(chart.point p) => ...')", () => {
    const script = parse(["f(chart.point p) =>", "    p.price"].join("\n"));
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]).toMatchObject({ name: "p", typeHint: "chart.point" });
  });

  it("parses a qualifier-prefixed 'chart.point' function parameter ('series chart.point p')", () => {
    const script = parse(["f(series chart.point p) =>", "    p.price"].join("\n"));
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params[0]).toMatchObject({ name: "p", typeHint: "series chart.point" });
  });

  it("parses two 'chart.point' function parameters in the same signature (wild idiom)", () => {
    const script = parse(["f(chart.point firstPoint, chart.point secondPoint) =>", "    firstPoint.price"].join("\n"));
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.params.map((p) => p.typeHint)).toEqual(["chart.point", "chart.point"]);
    expect(stmt.params.map((p) => p.name)).toEqual(["firstPoint", "secondPoint"]);
  });
});

// C725: UDT 필드의 varip 한정자(TV v6 신규, wild 7건, tv_verdict accept 실측 확인) — pine2js는
// intrabar 시뮬레이션이 없는 배치 리플레이 모델이라(GOAL.md) top-level var/varip처럼 파싱만
// 하고 한정자를 버린다(VarDecl.persistent가 이미 var/varip 구분 없음, parseVarDecl 대조).
describe("Parser UDT field varip qualifier ('varip TYPE name', C725, wild 7건)", () => {
  it("parses a 'varip float x' field the same as an unqualified field (qualifier discarded)", () => {
    const script = parse(["type Dom", "    varip float totalVolume"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "totalVolume", typeHint: "float", default: null });
  });

  it("parses a 'var float x' field the same way (var/varip symmetric)", () => {
    const script = parse(["type Dom", "    var float totalVolume"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "totalVolume", typeHint: "float" });
  });

  it("parses a 'varip' generic field type ('varip map<float,float> totalVolume', wild idiom)", () => {
    const script = parse(["type Dom", "    varip map<float,float> totalVolume"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "totalVolume", typeHint: "map<float, float>" });
  });

  it("parses multiple 'varip' fields in the same type declaration alongside a plain field", () => {
    const script = parse(
      ["type Dom", "    varip float totalVolume", "    varip float sellVolume", "    float top"].join("\n"),
    );
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields.map((f) => f.name)).toEqual(["totalVolume", "sellVolume", "top"]);
    expect(stmt.fields.map((f) => f.typeHint)).toEqual(["float", "float", "float"]);
  });

  it("parses a 'varip' field with a default value expression", () => {
    const script = parse(["type Dom", "    varip float totalVolume = 0.0"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]!.typeHint).toBe("float");
    expect(stmt.fields[0]!.default).not.toBeNull();
  });
});

// C725: UDT 필드 타입힌트 생략 숏핸드('field_name = default', 기본값 리터럴에서 타입 추론) —
// TV v5/v6 wild 4건, tv_verdict accept 실측 확인. pine2py _parse_type_field는 이 조합을
// 지원하지 않아(첫 식별자를 무조건 type_hint로 소비 후 ASSIGN을 만나 오파싱, 소스 대조 확인)
// 오라클 근거 없는 hand-verified 규칙 — typeHint는 리터럴 종류(raw 소수점/지수 유무로 int/float
// 구분)로 합성, 리터럴이 아닌 기본값은 float로 안전 폴백.
describe("Parser UDT field implicit type hint from default value ('field_name = default', C725, wild 4건)", () => {
  it("infers 'bool' from a bool literal default ('confirmed = false')", () => {
    const script = parse(["type pivot", "    confirmed = false"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "confirmed", typeHint: "bool" });
    expect(stmt.fields[0]!.default).not.toBeNull();
  });

  it("infers 'int' from an integer literal default ('condindex = 0')", () => {
    const script = parse(["type BoostCondCtx", "    condindex = 0"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "condindex", typeHint: "int" });
  });

  it("infers 'float' from a decimal-point literal default ('avg = 0.0')", () => {
    const script = parse(["type Stats", "    avg = 0.0"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "avg", typeHint: "float" });
  });

  it("infers 'string' from a string literal default ('name = \"\"')", () => {
    const script = parse(["type BoostCondCtx", '    name = ""'].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "name", typeHint: "string" });
  });

  it("infers 'string' from a non-empty string literal default (enum-like constants idiom)", () => {
    const script = parse(["type CONSTANTS", '    ACTION_BUY = "buy"'].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "ACTION_BUY", typeHint: "string" });
  });

  it("infers 'int' from a negative integer literal default ('offset = -1')", () => {
    const script = parse(["type Ctx", "    offset = -1"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "offset", typeHint: "int" });
  });

  it("parses multiple implicit-type fields alongside explicit-type fields in one declaration", () => {
    const script = parse(
      ["type pivot", "    float price", "    confirmed = false", "    int barIndex = bar_index"].join("\n"),
    );
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields.map((f) => f.name)).toEqual(["price", "confirmed", "barIndex"]);
    expect(stmt.fields.map((f) => f.typeHint)).toEqual(["float", "bool", "int"]);
  });

  it("does not affect an explicitly-typed field whose name happens to be followed by a further declaration", () => {
    const script = parse(["type pivot", "    float price = 1.0"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "price", typeHint: "float" });
  });

  it("treats a bare base-type-name identifier followed by ASSIGN as a field named after it, not a dangling type-hint ('float = 0.0' -- 'float' is a plain IDENTIFIER token in this lexer, not a reserved keyword, so this is indistinguishable from any other implicit-type field)", () => {
    const script = parse(["type Signal", "    float = 0.0"].join("\n"));
    const stmt = script.body[0] as TypeDecl;
    expect(stmt.fields[0]).toMatchObject({ kind: "TypeField", name: "float", typeHint: "float" });
  });
});

describe("Parser enum (literal members only, UDT slice 2)", () => {
  it("parses an enum declaration with a single member", () => {
    const script = parse(["enum Bar", "    long"].join("\n"));
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as EnumDecl;
    expect(stmt.kind).toBe("EnumDecl");
    expect(stmt.name).toBe("Bar");
    expect(stmt.members).toHaveLength(1);
    expect(stmt.members[0]).toMatchObject({ kind: "EnumMember", name: "long" });
  });

  it("parses an enum declaration with multiple bare members in order", () => {
    const script = parse(["enum Direction", "    long", "    short", "    flat"].join("\n"));
    const stmt = script.body[0] as EnumDecl;
    expect(stmt.members.map((m) => m.name)).toEqual(["long", "short", "flat"]);
  });

  it("parses an enum declaration with zero members", () => {
    const script = parse("enum Empty");
    const stmt = script.body[0] as EnumDecl;
    expect(stmt.members).toEqual([]);
  });

  it("parses a member title assignment ('member = \"string\"') and stores it on the member", () => {
    const script = parse(["enum Direction", '    long = "Long Position"'].join("\n"));
    const stmt = script.body[0] as EnumDecl;
    expect(stmt.members[0]).toMatchObject({ kind: "EnumMember", name: "long", title: "Long Position" });
  });

  it("parses a bare member (no '=') with title: null", () => {
    const script = parse(["enum Direction", "    long"].join("\n"));
    const stmt = script.body[0] as EnumDecl;
    expect(stmt.members[0]).toMatchObject({ kind: "EnumMember", name: "long", title: null });
  });

  it("parses a mix of bare and titled members in the same enum", () => {
    const script = parse(
      ["enum Direction", "    long", '    short = "Short Position"', "    flat"].join("\n"),
    );
    const stmt = script.body[0] as EnumDecl;
    expect(stmt.members.map((m) => [m.name, m.title])).toEqual([
      ["long", null],
      ["short", "Short Position"],
      ["flat", null],
    ]);
  });

  it("rejects a non-string-literal member value (e.g. a number, unlike pine2py's more permissive arbitrary-expression allowance)", () => {
    expect(() => parse(["enum Direction", "    long = 1"].join("\n"))).toThrow();
  });

  it("rejects the corpus-representative numeric-enum pattern (C218 -- 165/6926 corpus scripts use `Member = <int literal>`, incl. negative values, as a Python-Enum-style backing value rather than a TV title string) with the enum-member-title error, not a different/misleading one", () => {
    // corpus/scripts/009bcba1746c.pine 등 다수(전수: 165/6926, DIVERGENCES.md #63)가 이 패턴을 씀 --
    // pine2py는 임의 표현식을 허용하지만 TV v5 실제 문법은 title이 문자열 리터럴이어야 한다(C136).
    // 음수 리터럴(MINUS 토큰)도 동일하게 거부되는지는 이전 테스트(양수만)가 커버하지 않았음.
    expect(() =>
      parse(["enum Dir", "    Bull = 1", "    Bear = -1"].join("\n")),
    ).toThrow(/enum member title/);
  });

  it("parses 'EnumName.member' as an ordinary DotAccess, same shape as UDT field reads", () => {
    const script = parse("d = Direction.long");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "DotAccess", attr: "long" });
    expect((stmt.value as DotAccess).obj).toMatchObject({ kind: "Identifier", name: "Direction" });
  });

  it("parses an enum member comparison as an ordinary BinOp", () => {
    const script = parse("y = d == Direction.long");
    const stmt = script.body[0] as Assignment;
    const bin = stmt.value as BinOp;
    expect(bin.op).toBe("==");
    expect(bin.right).toMatchObject({ kind: "DotAccess", attr: "long" });
  });
});

describe("Parser DotAccess keyword-as-attr (C134 — unblocks input.enum)", () => {
  // 'enum'은 `enum Name` 선언(C122)을 위한 예약 키워드 토큰(ENUM)이라, 그동안 DotAccess attr
  // 파싱(IDENTIFIER 토큰만 허용)이 `input.enum(...)`을 parse-time에 즉시 거부했다(C133에서 발견).
  // pine2py parser.py의 `_KEYWORD_AS_ATTR`(dot 뒤에서는 어떤 예약 키워드가 와도 attr로 허용,
  // "input.enum, label.style_cross 등"이라는 원본 주석 그대로)를 이식해 해결 — 이 세트가
  // 나머지 예약어(type/method/import/export/strategy/indicator/library/var/varip/if/for/
  // while/switch)까지 포함하므로 enum 하나만이 아니라 세트 전체가 attr 위치에서 파싱됨을 확인.
  it("parses 'input.enum(...)' without throwing (the concrete case that blocked this slice)", () => {
    const script = parse('x = input.enum("A", "Choice")');
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
    const call = stmt.value as CallExpr;
    expect(call.callee).toMatchObject({ kind: "DotAccess", attr: "enum" });
  });

  it("parses other reserved keyword tokens in the same dot-attr position (pine2py's full KEYWORD_AS_ATTR set, not just 'enum')", () => {
    for (const attr of ["type", "method", "import", "export", "strategy", "indicator", "library", "var", "varip", "if", "for", "while", "switch"]) {
      const script = parse(`x = foo.${attr}`);
      const stmt = script.body[0] as Assignment;
      expect(stmt.value).toMatchObject({ kind: "DotAccess", attr });
    }
  });

  it("still rejects a non-keyword, non-identifier token after '.' (e.g. an operator)", () => {
    expect(() => parse("x = foo.+")).toThrow(/expected IDENTIFIER after '\./);
  });
});

describe("Parser method (UDT slice 4)", () => {
  it("parses a method declaration with a single-line expression body", () => {
    const script = parse("method area(Point p) => p.x");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.kind).toBe("MethodDecl");
    expect(stmt.name).toBe("area");
    expect(stmt.params).toHaveLength(1);
    expect(stmt.params[0]).toMatchObject({ kind: "FuncParam", name: "p", typeHint: "Point", default: null });
    expect(stmt.body).toHaveLength(1);
    expect(stmt.body[0]).toMatchObject({ kind: "ExprStmt" });
  });

  it("parses a method declaration with an indented multi-statement body", () => {
    const script = parse(["method translate(Point p, float dx) =>", "    p.x := p.x + dx", "    p.x"].join("\n"));
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.name).toBe("translate");
    expect(stmt.params.map((p) => p.name)).toEqual(["p", "dx"]);
    expect(stmt.body).toHaveLength(2);
    expect(stmt.body[0]).toMatchObject({ kind: "FieldAssignment", field: "x" });
  });

  it("parses multiple parameters with mixed type hints, matching FuncParam's general typeHint parsing", () => {
    const script = parse("method combine(Point p, float dx, dy) => p.x");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.params.map((p) => p.typeHint)).toEqual(["Point", "float", null]);
  });

  it("parses a method with a defaulted trailing parameter", () => {
    const script = parse("method bump(Point p, float dx = 1.0) => p.x");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.params[1]!.default).toMatchObject({ kind: "NumberLiteral", value: 1 });
  });

  it("parses a method with zero parameters (edge case — analyzer rejects this, but the parser is permissive)", () => {
    const script = parse("method noop() => 1.0");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.params).toEqual([]);
  });

  it("parses 'obj.method(args)' as an ordinary CallExpr over a DotAccess callee, same shape as 'TypeName.new(...)'", () => {
    const script = parse("pt.translate(1.0, 2.0)");
    const stmt = script.body[0] as ExprStmt;
    const call = stmt.expr as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "DotAccess", attr: "translate" });
    expect((call.callee as DotAccess).obj).toMatchObject({ kind: "Identifier", name: "pt" });
    expect(call.args).toHaveLength(2);
  });

  it("distinguishes a method declaration from a same-named UDF declaration by the leading keyword", () => {
    const methodScript = parse("method f(Point p) => p.x");
    const funcScript = parse("f(p) => p");
    expect((methodScript.body[0] as MethodDecl).kind).toBe("MethodDecl");
    expect((funcScript.body[0] as FuncDecl).kind).toBe("FuncDecl");
  });

  it("rejects a method declaration missing '=>'", () => {
    expect(() => parse("method f(Point p)")).toThrow();
  });

  // C768: 기존엔 "이름 없는 method decl은 무효"로 가정해 하드 에러를 기대했으나, wild TV-accept
  // 실측(corpus/wild/scripts_v56_v2/9a881fdba297.pine, 9e6529b4e316.pine: `method(int idx) =>
  // idx + 1`)이 이 가정을 반증했다 — TV는 이름 자리가 비면 "method"를 그 함수 자신의 이름으로 받는
  // 평범한 FuncDecl로 해석한다(1차 소스: tv_verdict_v2.jsonl accept). 정정.
  it("parses 'method (...) => ...' with no name as a FuncDecl literally named 'method' (wild TV-accept evidence, C768)", () => {
    const script = parse("method (Point p) => p.x");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.kind).toBe("FuncDecl");
    expect(stmt.name).toBe("method");
  });
});

describe("Parser method decl with reserved-word name/self-name (C768, wild scripts_v56_v2 evidence)", () => {
  it("parses 'method(...)' (no space, no name) as a FuncDecl named 'method' with a typed param, matching wild 9a881fdba297.pine", () => {
    const script = parse(["method(int idx) =>", "    idx + 1"].join("\n"));
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.kind).toBe("FuncDecl");
    expect(stmt.name).toBe("method");
    expect(stmt.params).toMatchObject([{ name: "idx", typeHint: "int" }]);
  });

  it("supports zero parameters for the self-named 'method()' FuncDecl form", () => {
    const script = parse("method() => 1.0");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.kind).toBe("FuncDecl");
    expect(stmt.name).toBe("method");
    expect(stmt.params).toEqual([]);
  });

  it("supports multiple parameters for the self-named 'method(...)' FuncDecl form", () => {
    const script = parse("method(float a, float b) => a + b");
    const stmt = script.body[0] as FuncDecl;
    expect(stmt.name).toBe("method");
    expect(stmt.params.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("still parses a normal named method decl right after the self-named form is checked (dispatch order regression)", () => {
    const script = parse("method translate(Point p) => p.x");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.kind).toBe("MethodDecl");
    expect(stmt.name).toBe("translate");
  });

  it("parses 'method type(...) => ...' as a MethodDecl named 'type' (reserved-word name), matching wild 7c4a84d1c416.pine", () => {
    const script = parse("method type(string str) => str");
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.kind).toBe("MethodDecl");
    expect(stmt.name).toBe("type");
    expect(stmt.params).toMatchObject([{ name: "str", typeHint: "string" }]);
  });

  it("accepts other KEYWORD_AS_ATTR reserved words as a method decl name (same mechanism as parseVarDecl C766)", () => {
    for (const kw of ["strategy", "enum", "import"]) {
      const script = parse(`method ${kw}(Point p) => p.x`);
      const stmt = script.body[0] as MethodDecl;
      expect(stmt.kind).toBe("MethodDecl");
      expect(stmt.name).toBe(kw);
    }
  });

  it("parses a reserved-word-named method with an indented multi-statement body", () => {
    const script = parse(["method type(string str) =>", "    x = str", "    x"].join("\n"));
    const stmt = script.body[0] as MethodDecl;
    expect(stmt.name).toBe("type");
    expect(stmt.body).toHaveLength(2);
  });

  it("rejects a method decl missing '=>' even in the self-named form", () => {
    expect(() => parse("method(int idx)")).toThrow();
  });
});

// C212: `TYPE name = expr`(var/varip 없는 신규 '=' 로컬 선언에 타입 힌트가 붙은 형태, 예:
// `float x = 1.0`) 파서 지원 신규. 이전엔 parseAssignmentOrExpr가 이 패턴을 몰라 TYPE 토큰이
// 별개의 미해결 ExprStmt(Identifier)로 떨어져 나가고 "name = expr"만 뒤이은 Assignment로
// 파싱됐다(analyzer가 그 orphan Identifier를 "알 수 없는 식별자"로 거부 -- corpus transpile_fail
// 최다빈도 클러스터, PROGRESS.md C211 next_hint). pine2py parser.py _parse_identifier_statement
// (L324-332)의 "타입 힌트 + 변수 선언" 분기 literal port -- codegen._gen_var_decl(L436)이
// var_type=None(이 분기가 만드는 값)이면 type_hint를 전혀 참조하지 않고 `name = value`만
// 방출함을 소스 대조로 확인(순수 장식)이라, codegen 출력은 기존 무타입 '=' 로컬과 완전히 동일하다.
// **C386 갱신**: codegen엔 여전히 장식이지만, analyzer가 UDT 필드 접근 판별(explicitUdtType,
// VarDecl과 동일 원칙)에 쓸 수 있도록 Assignment.typeHint에 보존한다(이전엔 완전히 버려졌음).
describe("Parser typed bare local declaration ('float x = 1.0', var 없음, C212/C386)", () => {
  it("parses 'float x = 1.0' as a single Assignment, preserving the type hint on Assignment.typeHint (C386, no separate orphan statement)", () => {
    const script = parse("float x = 1.0");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe("=");
    expect(stmt.name).toBe("x");
    expect(stmt.typeHint).toBe("float");
    expect(stmt.value).toMatchObject({ kind: "NumberLiteral", value: 1 });
  });

  it("parses 'int n = 5'", () => {
    const script = parse("int n = 5");
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("n");
    expect(stmt.typeHint).toBe("int");
    expect(stmt.value).toMatchObject({ kind: "NumberLiteral", value: 5 });
  });

  it("parses 'bool flag = true'", () => {
    const script = parse("bool flag = true");
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("flag");
    expect(stmt.typeHint).toBe("bool");
    expect(stmt.value).toMatchObject({ kind: "BoolLiteral", value: true });
  });

  it("parses 'string s = \"hi\"'", () => {
    const script = parse('string s = "hi"');
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("s");
    expect(stmt.typeHint).toBe("string");
    expect(stmt.value).toMatchObject({ kind: "StringLiteral", value: "hi" });
  });

  it("parses a typed local whose value is a larger expression (BinOp over a bar series)", () => {
    const script = parse("float y = close + 1");
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("y");
    expect(stmt.typeHint).toBe("float");
    expect(stmt.value).toMatchObject({ kind: "BinOp", op: "+" });
  });

  it("parses a UDT-named type hint too ('Bar p = expr', the C386 motivating case -- Assignment.typeHint carries the raw identifier regardless of whether it names a registered UDT)", () => {
    const script = parse("Bar p = w.inner");
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("p");
    expect(stmt.typeHint).toBe("Bar");
    expect(stmt.value).toMatchObject({ kind: "DotAccess", attr: "inner" });
  });

  it("does not consume a type-hint token for a plain untyped '=' local (no regression, typeHint stays null)", () => {
    const script = parse("x = 1.0");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("x");
    expect(stmt.typeHint).toBeNull();
  });

  it("keeps typeHint null for a ':=' reassignment (no leading type token to capture)", () => {
    const script = parse("x = 1.0\nx := 2.0");
    const stmt = script.body[1] as Assignment;
    expect(stmt.operator).toBe(":=");
    expect(stmt.typeHint).toBeNull();
  });

  it("keeps typeHint null for a compound assignment ('x += 1', no leading type token to capture)", () => {
    const script = parse("x = 1.0\nx += 1.0");
    const stmt = script.body[1] as Assignment;
    expect(stmt.operator).toBe(":=");
    expect(stmt.typeHint).toBeNull();
  });

  it("does not interfere with 'var float x = 1.0' (still routed through parseVarDecl)", () => {
    const script = parse("var float x = 1.0");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.typeHint).toBe("float");
    expect(stmt.name).toBe("x");
  });

  it("produces exactly two top-level statements for 'float x = 1.0' followed by another statement (no leaked orphan ExprStmt)", () => {
    const script = parse("float x = 1.0\nplot(x)");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("Assignment");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });

  it("parses a typed local declared inside an if-block body", () => {
    const script = parse("if close > 0\n    float x = 1.0\n");
    const ifStmt = script.body[0] as IfStmt;
    expect(ifStmt.thenBody).toHaveLength(1);
    expect(ifStmt.thenBody[0]!.kind).toBe("Assignment");
    expect((ifStmt.thenBody[0] as Assignment).name).toBe("x");
  });

  it("parses a typed local declared inside a UDF body", () => {
    const script = parse("f(p) =>\n    float x = p + 1.0\n    x\n");
    const fn = script.body[0] as FuncDecl;
    expect(fn.body[0]!.kind).toBe("Assignment");
    expect((fn.body[0] as Assignment).name).toBe("x");
  });
});

// C635: `TYPE name`(초기값 생략, var 없음 — 예: `float x`) 파서 지원 신규. 위 C212(`float x = 1.0`)의
// 자매 폼이지만 ASSIGN이 아예 없어 문장이 두 토큰(타입/이름)으로 끝난다. 이전엔 parseAssignmentOrExpr가
// 이 패턴을 몰라 두 토큰 모두 별개의 미해결 ExprStmt(Identifier)로 조용히 쪼개졌다(C212와 동일한
// 침묵 오분할 클래스, wild "알 수 없는 식별자" 클러스터 잔여 서브버킷, next_hint(C634)). pine2py
// _parse_identifier_statement(parser.py L324-334)엔 이 분기가 아예 없어(ASSIGN 필수) pine2py 자신도
// python 직접 실행 확인 결과 동일하게 조용히 두 문장으로 쪼갠다 — literal port 불가, 값 노드
// `{ kind: "NaLiteral" }`를 합성해 기존 'TYPE name = na' 명시적 폼과 동일한 AST로 desugar한다
// (DIVERGENCES에 TV 미검증(가설)로 등재).
describe("Parser typed bare local declaration with no initializer ('float x', var 없음, C635)", () => {
  it("parses 'float x' as a single Assignment with a synthesized NaLiteral value (no separate orphan statement)", () => {
    const script = parse("float x");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe("=");
    expect(stmt.name).toBe("x");
    expect(stmt.typeHint).toBe("float");
    expect(stmt.value).toMatchObject({ kind: "NaLiteral" });
  });

  it("parses 'string s' (reference-type hint, still desugars to the same shape)", () => {
    const script = parse("string s");
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("s");
    expect(stmt.typeHint).toBe("string");
    expect(stmt.value).toMatchObject({ kind: "NaLiteral" });
  });

  it("parses a UDT-named type hint too ('Bar p', mirrors C386's Assignment.typeHint contract)", () => {
    const script = parse("Bar p");
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("p");
    expect(stmt.typeHint).toBe("Bar");
    expect(stmt.value).toMatchObject({ kind: "NaLiteral" });
  });

  it("produces exactly two top-level statements for 'float x' followed by another statement (no leaked orphan ExprStmt)", () => {
    const script = parse("float x\nplot(x)");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("Assignment");
    expect((script.body[0] as Assignment).name).toBe("x");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });

  it("parses a bare declaration followed by a conditional ':=' reassignment (the motivating wild idiom)", () => {
    const script = parse("float ma\nif close > 0\n    ma := close\n");
    expect(script.body).toHaveLength(2);
    const decl = script.body[0] as Assignment;
    expect(decl.name).toBe("ma");
    expect(decl.operator).toBe("=");
    expect(decl.typeHint).toBe("float");
    const ifStmt = script.body[1] as IfStmt;
    const reassign = ifStmt.thenBody[0] as Assignment;
    expect(reassign.name).toBe("ma");
    expect(reassign.operator).toBe(":=");
  });

  it("parses a bare declaration inside an if-block body", () => {
    const script = parse("if close > 0\n    float x\n");
    const ifStmt = script.body[0] as IfStmt;
    expect(ifStmt.thenBody).toHaveLength(1);
    expect(ifStmt.thenBody[0]!.kind).toBe("Assignment");
    expect((ifStmt.thenBody[0] as Assignment).name).toBe("x");
  });

  it("parses a bare declaration inside a UDF body", () => {
    const script = parse("f(p) =>\n    float x\n    x := p + 1.0\n    x\n");
    const fn = script.body[0] as FuncDecl;
    expect(fn.body[0]!.kind).toBe("Assignment");
    expect((fn.body[0] as Assignment).name).toBe("x");
    expect((fn.body[0] as Assignment).value).toMatchObject({ kind: "NaLiteral" });
  });

  it("does not misfire for a single bare identifier followed by a value expression on the next line (no accidental 2-statement merge)", () => {
    const script = parse("close\nvolume\n");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("ExprStmt");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });

  it("still requires ASSIGN for the C212 typed-init form (no regression — 'float x = 1.0' unaffected)", () => {
    const script = parse("float x = 1.0");
    const stmt = script.body[0] as Assignment;
    expect(stmt.value).toMatchObject({ kind: "NumberLiteral", value: 1 });
  });

  it("does not fire for a qualifier-prefixed declaration ('series float x', handled by the qualified-decl branch, not this one)", () => {
    const script = parse("series float x = 1.0");
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("x");
    expect(stmt.typeHint).toBe("float");
  });

  it("parses a bare declaration as the last statement in a block (DEDENT terminator, not just NEWLINE)", () => {
    const script = parse("if close > 0\n    float x\nplot(1)");
    const ifStmt = script.body[0] as IfStmt;
    expect(ifStmt.thenBody).toHaveLength(1);
    expect((ifStmt.thenBody[0] as Assignment).name).toBe("x");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });
});

// C487: 한정자 없는 dotted 타입 신규 로컬 선언(`chart.point end = expr`, var 없음) 파서 지원 신규.
// 위 typed bare local(`float x = 1.0`, C386)과 동일한 그룹의 gap이지만 "IDENTIFIER DOT IDENTIFIER
// IDENTIFIER ASSIGN" 4-토큰 패턴만 그 lookahead 목록에 빠져 있었다 -- parseExpr()이 "chart.point"
// 까지만 DotAccess로 파싱하고 멈춰 C212와 동일하게 문장이 조용히 둘로 쪼개졌다(bare DotAccess
// ExprStmt "chart.point" + 별개 무타입 Assignment "end = ..."). parseFuncParam L521(C486)의 동일
// dot-chain lookahead를 이식(wild 29b3b91c4388.pine L271/292 실측).
describe("Parser dotted-type bare local declaration ('chart.point end = expr', var 없음, C487)", () => {
  it("parses 'chart.point end = chart.point.new(...)' as a single Assignment, preserving the dotted type hint on Assignment.typeHint (no separate orphan statement)", () => {
    const script = parse("chart.point end = chart.point.new(time, bar_index, close)");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe("=");
    expect(stmt.name).toBe("end");
    expect(stmt.typeHint).toBe("chart.point");
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("parses 'chart.point point = findPivotPoint(src, depth, isHigh)' (dotted type + UDF-call RHS, exact wild pattern L271)", () => {
    const script = parse("chart.point point = findPivotPoint(src, depth, isHigh)");
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("point");
    expect(stmt.typeHint).toBe("chart.point");
  });

  it("does not interfere with a plain dotted-type expression statement that isn't a declaration ('chart.point.new(...)' alone, no trailing name+ASSIGN)", () => {
    const script = parse("chart.point.new(time, bar_index, close)");
    expect(script.body).toHaveLength(1);
    expect(script.body[0]!.kind).toBe("ExprStmt");
  });

  it("parses a dotted-type local declared inside an if-block body", () => {
    const script = parse("if close > 0\n    chart.point p = chart.point.new(time, bar_index, close)\n");
    const ifStmt = script.body[0] as IfStmt;
    expect(ifStmt.thenBody).toHaveLength(1);
    expect(ifStmt.thenBody[0]!.kind).toBe("Assignment");
    expect((ifStmt.thenBody[0] as Assignment).typeHint).toBe("chart.point");
  });

  it("parses a dotted-type local declared inside a method body (exact wild shape, L271/L292)", () => {
    const script = parse(["method tryFindPivot(series ZigZag this) =>", "    chart.point point = na", "    point"].join("\n"));
    const method = script.body[0] as MethodDecl;
    expect(method.body[0]!.kind).toBe("Assignment");
    expect((method.body[0] as Assignment).typeHint).toBe("chart.point");
  });

  it("produces exactly two top-level statements for a dotted-type local followed by another statement (no leaked orphan token)", () => {
    const script = parse("chart.point end = chart.point.new(time, bar_index, close)\nplot(end.price)");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("Assignment");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });
});

// C518: wild "expected ASSIGN in var declaration, got DOT" 클러스터(48건, corpus_scan top-15
// 재실측) — parseVarDecl(var/varip 전용)이 C486(필드/매개변수)/C487(무한정자 '=' 로컬)와 달리
// dotted 타입 lookahead가 아예 없어 `var chart.point p = ...`의 "chart"가 그대로 nameTok으로
// 소비되고 뒤이은 '.'에서 크래시했다. C487의 4-토큰 lookahead(IDENTIFIER DOT IDENTIFIER
// IDENTIFIER)와 대괄호 shorthand 분기(기존 단일-식별자 전용)를 모두 var 선언에도 대칭 확장.
// wild 48건 중 13건(chart.point)이 이 축, 나머지(qt.QTConfig/zg.*/zigzag.* 등)는 라이브러리
// import 타입이라 파싱은 통과해도 analyzer가 별도 이유로 여전히 거부(구조적 범위 밖, 재조사 불필요).
describe("Parser dotted-type var/varip declaration ('var chart.point p = expr', C518)", () => {
  it("parses 'var chart.point p = chart.point.new(...)' with typeHint 'chart.point'", () => {
    const script = parse("var chart.point p = chart.point.new(time, bar_index, close)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.name).toBe("p");
    expect(stmt.typeHint).toBe("chart.point");
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("parses 'varip chart.point p = na' with typeHint 'chart.point' (varip variant)", () => {
    const script = parse("varip chart.point p = na");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("chart.point");
    expect(stmt.name).toBe("p");
  });

  it("parses 'var chart.point[] pivots = array.new<chart.point>()' normalized to typeHint 'array<chart.point>'", () => {
    const script = parse("var chart.point[] pivots = array.new<chart.point>()");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("array<chart.point>");
    expect(stmt.name).toBe("pivots");
  });

  it("parses a dotted type from an imported-library alias ('var qt.QTConfig cfg = ...') without a raw parse crash (analyzer decides support separately)", () => {
    const script = parse("var qt.QTConfig cfg = qt.qt_config_default()");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("qt.QTConfig");
    expect(stmt.name).toBe("cfg");
  });

  it("still parses the pre-existing single-identifier var-decl forms unchanged ('var float x = 1.0', 'var float[] arr = ...')", () => {
    const s1 = parse("var float x = 1.0");
    expect((s1.body[0] as VarDecl).typeHint).toBe("float");
    const s2 = parse("var float[] arr = array.new_float(0)");
    expect((s2.body[0] as VarDecl).typeHint).toBe("array<float>");
  });

  it("produces exactly two top-level statements for a dotted-type var-decl followed by another statement (no leaked orphan token)", () => {
    const script = parse("var chart.point p = chart.point.new(time, bar_index, close)\nplot(p.price)");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("VarDecl");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });
});

// C754: 점 접근 타입(`chart.point`) + 대괄호-접미 배열 shorthand + 신규 로컬(var 없음)/함수
// 매개변수 위치. C518(var 선언)/C486(UDT 필드)/C486(func-param 무한정자)까지 이 조합을 지원했으나
// var 없는 신규 로컬(parseAssignmentOrExpr)과 func-param dot-chain 분기(L609)에는 대괄호 확인이
// 빠져 있었다 -- wild `chart.point[] points = array.new<chart.point>()`(UDF 본문 첫 신규 로컬)가
// "예상치 못한 토큰 RBRACKET"으로 하드 크래시(corpus_scan RBRACKET 클러스터 14건 중 13건 tv_verdict
// accept 확인).
describe("Parser dotted-type + bracket-shorthand array, var 없는 신규 로컬/func-param (C754)", () => {
  it("parses 'chart.point[] points = array.new<chart.point>()' (no var) with typeHint 'array<chart.point>'", () => {
    const script = parse("chart.point[] points = array.new<chart.point>()");
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.name).toBe("points");
    expect(stmt.typeHint).toBe("array<chart.point>");
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("parses a dotted-type bracket-shorthand local declared inside a UDF body (exact wild shape)", () => {
    const script = parse(
      ["f() =>", "    chart.point[] points = array.new<chart.point>()", "    points"].join("\n"),
    );
    const fn = script.body[0] as FuncDecl;
    expect(fn.body[0]!.kind).toBe("Assignment");
    expect((fn.body[0] as Assignment).typeHint).toBe("array<chart.point>");
  });

  it("parses 'f(chart.point[] pts) => pts' (dotted-type bracket-shorthand function parameter)", () => {
    const script = parse("f(chart.point[] pts) =>\n    pts");
    const fn = script.body[0] as FuncDecl;
    expect(fn.params[0]!.name).toBe("pts");
    expect(fn.params[0]!.typeHint).toBe("array<chart.point>");
  });

  it("does not interfere with the bare (non-array) dotted-type new-local form ('chart.point end = expr', C487 unchanged)", () => {
    const script = parse("chart.point end = chart.point.new(time, bar_index, close)");
    const stmt = script.body[0] as Assignment;
    expect(stmt.typeHint).toBe("chart.point");
  });

  it("produces exactly two top-level statements for a dotted-type bracket-shorthand local followed by another statement (no leaked orphan token)", () => {
    const script = parse("chart.point[] points = array.new<chart.point>()\nplot(points.size())");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("Assignment");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });
});

// C213: `TYPE[] name = expr` 대괄호-접미 배열 타입 선언 shorthand(`array<float>`의 대체 표기,
// 예: `float[] arr = array.new_float(0)`) 파서 지원 신규. 이전엔 parseVarDecl/
// parseAssignmentOrExpr 둘 다 이 4-토큰 패턴(IDENTIFIER LBRACKET RBRACKET IDENTIFIER)을 몰라
// `float`를 변수명으로 오인 -> 그 다음 ASSIGN 자리에서 `[`를 만나 "expected ASSIGN ... got
// LBRACKET"로 실패했다(corpus 460개 파일, PROGRESS.md C212 next_hint 1순위). pine2py
// parser.py _is_array_type_shorthand/_consume_array_type_shorthand(L1003-1017) literal port --
// var/varip 경로(parseVarDecl)는 `array<${base}>`로 정규화한 typeHint를 그대로 저장(제네릭
// `array<float>` 표기와 동일한 문자열, analyzer.ts의 모든 varTypeHints 소비 지점과 무충돌 확인
// 완료 -- inferNumType/index-access.ts string·enum 체크/explicitUdtType 전부 이 문자열과
// 매치되지 않아 안전). var 없는 신규 로컬 경로(parseAssignmentOrExpr)도 C212와 동일하게
// `array<${base}>`로 정규화해 Assignment.typeHint에 보존한다(C386 -- codegen엔 여전히 순수 장식,
// analyzer의 explicitUdtType 판별만 이 문자열을 prog.udtTypes.has()로 걸러 씀).
describe("Parser bracket-suffix array type shorthand ('float[] x = ...', C213)", () => {
  it("parses 'var float[] arr = array.new_float(0)' as VarDecl with typeHint normalized to 'array<float>'", () => {
    const script = parse("var float[] arr = array.new_float(0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.name).toBe("arr");
    expect(stmt.typeHint).toBe("array<float>");
    expect(stmt.persistent).toBe(true);
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("parses 'var int[] xs = array.new_int(0)' (different base type)", () => {
    const script = parse("var int[] xs = array.new_int(0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("array<int>");
    expect(stmt.name).toBe("xs");
  });

  it("parses 'varip bool[] flags = array.new_bool(0)' (varip routes through the same branch)", () => {
    const script = parse("varip bool[] flags = array.new_bool(0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.typeHint).toBe("array<bool>");
    expect(stmt.name).toBe("flags");
  });

  it("parses 'float[] arr = array.new_float(0)' (var 없는 신규 로컬) as a single Assignment, preserving typeHint normalized to 'array<float>' (C386)", () => {
    const script = parse("float[] arr = array.new_float(0)");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe("=");
    expect(stmt.name).toBe("arr");
    expect(stmt.typeHint).toBe("array<float>");
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("parses 'string[] tags = array.new_string(0)' (var 없는 신규 로컬, string base type)", () => {
    const script = parse("string[] tags = array.new_string(0)");
    const stmt = script.body[0] as Assignment;
    expect(stmt.name).toBe("tags");
    expect(stmt.typeHint).toBe("array<string>");
  });

  it("does not interfere with plain multi-token expressions inside the RHS ('var float[] arr = array.new_float(0, 1.0)', no regression)", () => {
    const script = parse("var float[] arr = array.new_float(0, 1.0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("array<float>");
    expect(stmt.name).toBe("arr");
    expect((stmt.value as CallExpr).args).toHaveLength(2);
  });

  it("does not consume a bracket-type lookahead for a plain untyped 'var' declaration (no regression)", () => {
    const script = parse("var arr = array.new_float(0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBeNull();
    expect(stmt.name).toBe("arr");
  });

  it("does not consume a bracket-type lookahead for a plain untyped '=' local (no regression, Assignment.typeHint stays null)", () => {
    const script = parse("arr = array.new_float(0)");
    const stmt = script.body[0] as Assignment;
    expect(stmt.typeHint).toBeNull();
    expect(stmt.name).toBe("arr");
  });

  it("does not consume a bracket-type lookahead for tuple destructuring ('[a, b] = f()', no regression)", () => {
    const script = parse("[a, b] = f()");
    const stmt = script.body[0] as TupleDestructure;
    expect(stmt.kind).toBe("TupleDestructure");
    expect(stmt.names).toEqual(["a", "b"]);
  });

  it("does not consume a bracket-type lookahead for reading a history index ('y = x[1]', no regression)", () => {
    const script = parse("y = x[1]");
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.name).toBe("y");
    expect(stmt.value).toMatchObject({ kind: "IndexAccess" });
  });

  it("produces exactly two top-level statements for a bracket-shorthand local followed by another statement (no leaked orphan token)", () => {
    const script = parse("float[] arr = array.new_float(0)\nplot(array.get(arr, 0))");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("Assignment");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });

  it("parses a bracket-shorthand var declared inside a UDF body", () => {
    const script = parse("f(p) =>\n    var float[] arr = array.new_float(0)\n    arr\n");
    const fn = script.body[0] as FuncDecl;
    expect(fn.body[0]!.kind).toBe("VarDecl");
    expect((fn.body[0] as VarDecl).typeHint).toBe("array<float>");
  });
});

// C214: `var TYPE<...> name = expr`/바 없는 `TYPE<...> name = expr`(제네릭 '<>' 표기의 var/varip
// 및 var 없는 '=' 로컬 선언, 예: `var array<float> arr = array.new_float(0)`,
// `map<string, int> m = map.new<string, int>()`) 파서 지원 신규. 이전엔 parseVarDecl/
// parseAssignmentOrExpr 둘 다 `<`로 시작하는 제네릭 타입 토큰 시퀀스를 몰라 "expected ASSIGN ...
// got LT"로 실패했다(PROGRESS.md C213 next_hint 1순위, corpus 실측 `var (array|map|matrix)<...>`
// 14개 파일 + 바 없는 로컬 16개 파일). pine2py parser.py
// _is_generic_typed_var_decl/_parse_type_expression(L1113-1184) literal port -- lookahead는
// depth 카운팅으로 짝이 맞는 '>' 까지 스캔한 뒤 그 다음이 `IDENTIFIER '='`인지 확인하는
// isGenericTypedVarDecl 신규(기존 isGenericCallLookahead와 depth 카운팅 짝 규칙은 같지만
// 종단 조건이 다름). 타입 문자열 조립은 UDT 필드용 parseFieldTypeHint(이미 재귀 제네릭 지원)를
// 그대로 재사용 -- 대괄호 shorthand(C213)가 정규화하는 `array<float>`와 동일 포맷. var 없는
// 신규 로컬 경로도 C213과 동일하게 이 문자열을 Assignment.typeHint에 보존한다(C386).
describe("Parser generic angle-bracket type declaration ('array<float> x = ...', C214)", () => {
  it("parses 'var array<float> arr = array.new_float(0)' as VarDecl with typeHint 'array<float>'", () => {
    const script = parse("var array<float> arr = array.new_float(0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.name).toBe("arr");
    expect(stmt.typeHint).toBe("array<float>");
    expect(stmt.persistent).toBe(true);
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("parses 'var map<string, float> m = map.new<string, float>()' (multi-arg generic)", () => {
    const script = parse("var map<string, float> m = map.new<string, float>()");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.typeHint).toBe("map<string, float>");
    expect(stmt.name).toBe("m");
  });

  it("parses 'varip matrix<float> mtx = matrix.new<float>(2, 2, 0.0)' (varip routes through the same branch)", () => {
    const script = parse("varip matrix<float> mtx = matrix.new<float>(2, 2, 0.0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.typeHint).toBe("matrix<float>");
    expect(stmt.name).toBe("mtx");
  });

  it("parses nested generics 'var map<string, array<float>> reg = na' (recursive type-expr depth)", () => {
    const script = parse("var map<string, array<float>> reg = na");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("map<string, array<float>>");
    expect(stmt.name).toBe("reg");
  });

  it("parses 'array<float> arr = array.new_float(0)' (var 없는 신규 로컬) as a single Assignment, preserving typeHint 'array<float>' (C386)", () => {
    const script = parse("array<float> arr = array.new_float(0)");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe("=");
    expect(stmt.name).toBe("arr");
    expect(stmt.typeHint).toBe("array<float>");
    expect(stmt.value).toMatchObject({ kind: "CallExpr" });
  });

  it("parses 'map<string, int> m = map.new<string, int>()' (var 없는 신규 로컬, multi-arg generic)", () => {
    const script = parse("map<string, int> m = map.new<string, int>()");
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.name).toBe("m");
    expect(stmt.typeHint).toBe("map<string, int>");
  });

  it("does not misdetect a bare comparison statement as a generic type decl ('a < b', no closing '>' before newline)", () => {
    const script = parse("a < b\nc = 1.0");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("ExprStmt");
    expect((script.body[0] as ExprStmt).expr).toMatchObject({ kind: "BinOp", op: "<" });
    expect(script.body[1]!.kind).toBe("Assignment");
  });

  it("does not interfere with a plain comparison inside an assignment RHS ('x = a < b', no regression)", () => {
    const script = parse("x = a < b");
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.name).toBe("x");
    expect(stmt.value).toMatchObject({ kind: "BinOp", op: "<" });
  });

  it("does not consume a generic-type lookahead for a plain untyped 'var' declaration (no regression)", () => {
    const script = parse("var arr = array.new_float(0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBeNull();
    expect(stmt.name).toBe("arr");
  });

  it("produces exactly two top-level statements for a generic-type local followed by another statement (no leaked orphan token)", () => {
    const script = parse("array<float> arr = array.new_float(0)\nplot(array.get(arr, 0))");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("Assignment");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });

  it("parses a generic-type var declared inside a UDF body", () => {
    const script = parse("f(p) =>\n    var array<float> arr = array.new_float(0)\n    arr\n");
    const fn = script.body[0] as FuncDecl;
    expect(fn.body[0]!.kind).toBe("VarDecl");
    expect((fn.body[0] as VarDecl).typeHint).toBe("array<float>");
  });
});

// C221: `array.new<TYPE>(size, initial_value)` 제네릭 타입 인자 콜사이트 라우팅 신규 -- C220
// next_hint 1순위, corpus 144건 실측(137건 float). map.new<K,V>()(C89)와 달리 array.new는 값
// 타입별로 기본값이 다른 별개 런타임 생성자 5종(new_float/new_int/new_bool/new_string/new_color)이
// 이미 있어 타입 인자를 버릴 수 없다 -- parser가 이 콜사이트만 attr을 'new_<type>'으로 재작성해
// 기존 ARRAY_REGISTRY suffix 라우팅을 그대로 재사용(신규 analyzer/codegen 분기 불필요).
describe("Parser array.new<TYPE>(...) generic call-site routing (C221)", () => {
  function callExprOf(script: ReturnType<typeof parse>): CallExpr {
    const stmt = script.body[0] as VarDecl;
    return stmt.value as CallExpr;
  }

  it("rewrites 'array.new<float>(...)' callee attr to 'new_float'", () => {
    const script = parse("var a = array.new<float>(5, 0.0)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_float");
  });

  it("rewrites 'array.new<int>(...)' callee attr to 'new_int'", () => {
    const script = parse("var a = array.new<int>(3, 7)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_int");
  });

  it("rewrites 'array.new<bool>(...)' callee attr to 'new_bool'", () => {
    const script = parse("var a = array.new<bool>(2, true)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_bool");
  });

  it("rewrites 'array.new<string>(...)' callee attr to 'new_string'", () => {
    const script = parse('var a = array.new<string>(2, "hi")');
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_string");
  });

  it("rewrites 'array.new<color>(...)' callee attr to 'new_color'", () => {
    const script = parse("var a = array.new<color>(2, color.red)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_color");
  });

  it("parses 'array.new<float>()' with 0 arguments (both defaults)", () => {
    const script = parse("var a = array.new<float>()");
    const call = callExprOf(script);
    expect((call.callee as DotAccess).attr).toBe("new_float");
    expect(call.args).toHaveLength(0);
  });

  it("does not affect map.new<K,V>() generic calls (still discards type args, attr stays 'new', no regression)", () => {
    const script = parse("var m = map.new<string, float>()");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new");
  });

  it("does not affect a non-'.new' array method with a coincidental generic-looking lookahead (no regression on other array.* calls)", () => {
    const script = parse("var a = array.new_float(0)\nx = array.get(a, 0)");
    const stmt = script.body[1] as Assignment;
    const call = stmt.value as CallExpr;
    expect((call.callee as DotAccess).attr).toBe("get");
  });
});

// C230: array.new<T>(...)의 T가 5종 원시 타입 밖(사용자 UDT 타입명 또는 label/chart.point 같은
// built-in 특수 타입)일 때 -- C221 next_hint가 예고해둔 저비용 확장(corpus 4건 실측: label/Level/
// Entry/chart.point). C221 당시엔 이 형태를 만나면 그냥 attr='new'로 남겨(skipGenericArgs
// 폴백) analyzer가 "지원하지 않는 호출"로 거부했으나, 이제는 attr을 'new_generic' 하나로 통일
// 라우팅해 인정한다 -- pine2py도 T와 무관하게 동일한 무타입 단일 생성자로 라우팅해(_strip_generic)
// T별 분기가 원래 없다(python 직접 실행으로 확인). 아래 3건은 C221이 "폴백돼 attr이 'new'로 남는다"
// 로 단정했던 기존 테스트를 대체한 것 -- 의도된 지원 범위 확장이지 기존 기능의 버그 수정이 아니다
// (C227 선례와 동일 처리, zero_bug_streak 영향 없음).
describe("Parser array.new<TYPE>(...) generic call-site routing for non-primitive T (C230)", () => {
  function callExprOf(script: ReturnType<typeof parse>): CallExpr {
    const stmt = script.body[0] as VarDecl;
    return stmt.value as CallExpr;
  }

  it("rewrites 'array.new<label>(...)' callee attr to 'new_generic' (built-in special type)", () => {
    const script = parse("var a = array.new<label>(0)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_generic");
  });

  it("rewrites 'array.new<MyType>(...)' callee attr to 'new_generic' (user UDT type name)", () => {
    const script = parse("var a = array.new<MyType>(0)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_generic");
  });

  it("rewrites 'array.new<chart.point>(...)' callee attr to 'new_generic' (dotted/qualified built-in type)", () => {
    const script = parse("var pts = array.new<chart.point>(0)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_generic");
  });

  it("rewrites 'array.new<Entry>()' (0 args, capitalized single-identifier type) to 'new_generic'", () => {
    const script = parse("var entries = array.new<Entry>()");
    const call = callExprOf(script);
    expect((call.callee as DotAccess).attr).toBe("new_generic");
    expect(call.args).toHaveLength(0);
  });

  it("routes a capitalized identifier coinciding with a primitive name ('array.new<Float>(...)') to 'new_generic', not 'new_float' (case-sensitive primitive match)", () => {
    const script = parse("var a = array.new<Float>(0)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_generic");
  });

  it("routes a nested generic type arg ('array.new<array<float>>(...)') to 'new_generic' (C426 -- was 'new' fallback, wild corpus 2 files)", () => {
    const script = parse("var a = array.new<array<float>>(0)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_generic");
  });

  it("routes a nested map generic type arg ('array.new<map<string, float>>(...)') to 'new_generic' (C426)", () => {
    const script = parse("var a = array.new<map<string, float>>()");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_generic");
  });
});

// C355: consumeArrayNewGenericTypeArg가 T를 완전히 버리던 것(C230)을 DotAccess.genericElemType으로
// 보존하도록 확장 — 라우팅(attr='new_generic')은 그대로, T만 부가 정보로 추가. 착수 계기는
// next_hint(C354) 1순위: `var allGaps = array.new<Gap>()`(명시 typeHint 없음) 뒤
// `allGaps.shift().delete()`류가 이 T 소실 때문에 analyzer가 Gap을 UDT로 인식 못해 막혀 있었음.
describe("Parser array.new<TYPE>(...) preserves the generic type name (C355)", () => {
  function callExprOf(script: ReturnType<typeof parse>): CallExpr {
    const stmt = script.body[0] as VarDecl;
    return stmt.value as CallExpr;
  }

  it("captures 'Gap' on DotAccess.genericElemType for 'array.new<Gap>()' (user UDT type name)", () => {
    const script = parse("var allGaps = array.new<Gap>()");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_generic");
    expect(callee.genericElemType).toBe("Gap");
  });

  it("captures the full dotted name ('chart.point') for the dotted built-in type 'array.new<chart.point>(...)' (C490)", () => {
    const script = parse("var pts = array.new<chart.point>(0)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_generic");
    expect(callee.genericElemType).toBe("chart.point");
  });

  it("leaves genericElemType undefined when the type arg routes to a primitive suffix ('array.new<float>()' -> 'new_float')", () => {
    const script = parse("var nums = array.new<float>()");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_float");
    expect(callee.genericElemType).toBeUndefined();
  });

  it("captures only the outer first segment ('array') for a nested generic type arg ('array.new<array<float>>()', C426)", () => {
    const script = parse("var nested = array.new<array<float>>()");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new_generic");
    expect(callee.genericElemType).toBe("array");
  });
});

// C618: matrix.new<T>(...)도 array.new<T>(...)와 동일하게 T를 genericElemType으로 보존 -- wild
// `var Ang = matrix.new<line>(4,13,line(na))` 뒤 `Ang.get(0,i).delete()`류가 T 소실 때문에
// matrix<drawing/UDT> 원소 kind를 못 판별해 막혀 있던 것의 원인. matrix엔 array의 new_float 등
// 타입별 전용 생성자가 없어(MATRIX_REGISTRY는 "new" 하나뿐) attr은 항상 "new" 그대로 유지된다
// (array.new<float>()의 new_float 재작성과 다른 지점).
describe("Parser matrix.new<TYPE>(...) preserves the generic type name (C618)", () => {
  function callExprOf(script: ReturnType<typeof parse>): CallExpr {
    const stmt = script.body[0] as VarDecl;
    return stmt.value as CallExpr;
  }

  it("captures 'line' on DotAccess.genericElemType for 'matrix.new<line>(...)' and leaves attr as 'new'", () => {
    const script = parse("var Ang = matrix.new<line>(4, 13, line(na))");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new");
    expect(callee.genericElemType).toBe("line");
  });

  it("captures a user UDT type name ('Gap') for 'matrix.new<Gap>()' and leaves attr as 'new'", () => {
    const script = parse("var m = matrix.new<Gap>()");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new");
    expect(callee.genericElemType).toBe("Gap");
  });

  it("still captures a primitive type arg ('float') on genericElemType (no primitive-suffix routing for matrix)", () => {
    const script = parse("var m = matrix.new<float>(1, 1, 0.0)");
    const callee = callExprOf(script).callee as DotAccess;
    expect(callee.attr).toBe("new");
    expect(callee.genericElemType).toBe("float");
  });
});

// C219: `var/varip series/simple/const TYPE x = ...` 및 var 없는 `series/simple/const TYPE x = ...`
// (타입 한정자 접두 변수 선언) 파서 지원 신규 -- C195 parser 감사(ROADMAP "감사: lexer/parser/...")
// 잔여 스코프 2/3(1/3 for-in은 C215/216, 3/3 import/library는 사람 판단 대기로 범위 밖,
// LIMITATIONS.md 참조). 이전엔 parseVarDecl/parseAssignmentOrExpr 둘 다 SERIES/SIMPLE/CONST를
// IDENTIFIER와 다른 TokenType으로 안 봐(MEMORY.md C4 원칙) "expected IDENTIFIER in var
// declaration"/미해결 ExprStmt로 실패했다. pine2py parser.py
// _parse_var_decl(L220-225)/_parse_qualified_var_decl(L274-292) literal port -- 단 pine2py는
// type_hint를 "qualifier basetype" 합성 문자열("series float")로 저장하지만 codegen이 안 써서
// 순수 장식인 반면, pine2js의 varTypeHints는 int/string/enum 판별에 정확 문자열 매치로 실제
// 소비되므로(inferNumType 등) qualifier는 버리고 base type만 저장한다(관측 가능한 코드젠 차이
// 없음 -- pine2py 자신도 qualifier를 codegen에서 참조하지 않으므로 divergence 아님).
describe("Parser qualifier-prefixed type declaration ('var series/simple/const TYPE x = ...', C219)", () => {
  it("parses 'var series float x = 1.0' as VarDecl, discarding the qualifier and keeping only the base type as typeHint", () => {
    const script = parse("var series float x = 1.0");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.name).toBe("x");
    expect(stmt.typeHint).toBe("float");
    expect(stmt.persistent).toBe(true);
  });

  it("parses 'varip simple int y = 1' (varip routes through the same branch)", () => {
    const script = parse("varip simple int y = 1");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.name).toBe("y");
    expect(stmt.typeHint).toBe("int");
  });

  it("parses 'var const bool z = true'", () => {
    const script = parse("var const bool z = true");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.name).toBe("z");
    expect(stmt.typeHint).toBe("bool");
  });

  it("parses 'series float x = 1.0' (var 없는 신규 로컬) as a single Assignment, discarding the qualifier but preserving the base type as typeHint (C386)", () => {
    const script = parse("series float x = 1.0");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe("=");
    expect(stmt.name).toBe("x");
    expect(stmt.typeHint).toBe("float");
    expect(stmt.value).toMatchObject({ kind: "NumberLiteral" });
  });

  it("parses 'simple int y = 1' (var 없는 신규 로컬)", () => {
    const script = parse("simple int y = 1");
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.name).toBe("y");
    expect(stmt.typeHint).toBe("int");
  });

  it("parses 'const bool z = true' (var 없는 신규 로컬)", () => {
    const script = parse("const bool z = true");
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.name).toBe("z");
    expect(stmt.typeHint).toBe("bool");
  });

  it("does not affect a plain untyped 'var' declaration (no regression)", () => {
    const script = parse("var x = 1.0");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBeNull();
    expect(stmt.name).toBe("x");
  });

  it("does not interfere with the existing generic angle-bracket branch (no regression, C214)", () => {
    const script = parse("var array<float> arr = array.new_float(0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("array<float>");
  });

  it("throws ParseError for a bare qualifier with no base type ('series x = 1', not valid Pine syntax)", () => {
    expect(() => parse("series x = 1")).toThrow(ParseError);
  });

  it("produces exactly two top-level statements for a qualifier-typed local followed by another statement (no leaked orphan token)", () => {
    const script = parse("series float x = 1.0\nplot(x)");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("Assignment");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });

  it("parses a qualifier-typed var declared inside a UDF body", () => {
    const script = parse("f(p) =>\n    var series float x = 1.0\n    x\n");
    const fn = script.body[0] as FuncDecl;
    expect(fn.body[0]!.kind).toBe("VarDecl");
    expect((fn.body[0] as VarDecl).typeHint).toBe("float");
  });
});

// C634: `var/varip series/simple/const TYPE[] x = ...` 및 var 없는 `series/simple/const TYPE[]
// x = ...` (한정자 접두 + 대괄호-접미 배열 shorthand 조합) 파서 지원 신규 -- 위 C219(한정자+bare
// 타입)와 C213(무한정자 bracket-shorthand, 이 파일 상단 "Parser bracket-suffix array type
// shorthand" describe)이 각각 독립적으로 지원되던 두 축의 조합이 빠져 있던 갭(wild 8건 —
// `simple string[] sec = array.new<string>(15)` 근접 중복 6파일 + `const string[] exchanges =
// array.from(...)`/`var const int[] test_row_0 = array.from(...)` 각 1파일). pine2py도 동일한
// 파서 한계를 가짐(_parse_qualified_var_decl이 LBRACKET 분기 없음, python 직접 실행으로 확인)이라
// literal port 대상이 아니라 순수 문법 조합 신규 추가 -- C219와 동일하게 qualifier는 버리고
// base type만 typeHint로 보존하되 bracket-shorthand 규칙(C213)에 따라 array<base>로 정규화한다.
describe("Parser qualifier-prefixed bracket-suffix array type shorthand ('var series/simple/const TYPE[] x = ...', C634)", () => {
  it("parses 'var simple string[] sec = array.new<string>(15)' as VarDecl with typeHint normalized to 'array<string>'", () => {
    const script = parse("var simple string[] sec = array.new<string>(15)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.kind).toBe("VarDecl");
    expect(stmt.name).toBe("sec");
    expect(stmt.typeHint).toBe("array<string>");
    expect(stmt.persistent).toBe(true);
  });

  it("parses 'varip const int[] xs = array.new<int>(1)' (varip + const routes through the same branch)", () => {
    const script = parse("varip const int[] xs = array.new<int>(1)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("array<int>");
    expect(stmt.name).toBe("xs");
  });

  it("parses 'simple string[] sec = array.new<string>(15)' (var 없는 신규 로컬) as a single Assignment with typeHint normalized to 'array<string>'", () => {
    const script = parse("simple string[] sec = array.new<string>(15)");
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.operator).toBe("=");
    expect(stmt.name).toBe("sec");
    expect(stmt.typeHint).toBe("array<string>");
  });

  it("parses 'const string[] exchanges = array.from(a, b)' (var 없는 신규 로컬, 다른 한정자)", () => {
    const script = parse('const string[] exchanges = array.from("a", "b")');
    const stmt = script.body[0] as Assignment;
    expect(stmt.kind).toBe("Assignment");
    expect(stmt.name).toBe("exchanges");
    expect(stmt.typeHint).toBe("array<string>");
  });

  it("does not affect the plain qualifier bare-type branch (no regression, 'var series float x = 1.0')", () => {
    const script = parse("var series float x = 1.0");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("float");
  });

  it("does not affect the unqualified bracket-shorthand branch (no regression, 'var float[] arr = array.new_float(0)')", () => {
    const script = parse("var float[] arr = array.new_float(0)");
    const stmt = script.body[0] as VarDecl;
    expect(stmt.typeHint).toBe("array<float>");
  });

  it("produces exactly two top-level statements for a qualifier bracket-typed local followed by another statement (no leaked orphan token)", () => {
    const script = parse('simple string[] sec = array.new<string>(15)\nplot(1)');
    expect(script.body).toHaveLength(2);
    expect(script.body[0]!.kind).toBe("Assignment");
    expect(script.body[1]!.kind).toBe("ExprStmt");
  });

  it("parses a qualifier bracket-typed var declared inside a UDF body", () => {
    const script = parse("f(p) =>\n    var simple string[] sec = array.new<string>(15)\n    sec\n");
    const fn = script.body[0] as FuncDecl;
    expect(fn.body[0]!.kind).toBe("VarDecl");
    expect((fn.body[0] as VarDecl).typeHint).toBe("array<string>");
  });
});

// library()/export/import (C274) -- pine2py도 셋 다 순수 통과 파스(codegen이 comment 한 줄로
// 버리거나 아예 무시, docs/pinescript/09-edge-cases.md가 import를 "Phase 1 미지원, 외부 라이브러리
// 참조라 복잡"이라고 명시)라 pine2js도 동일하게 no-op으로 처리한다(위 parseScript/parseStatement
// 주석 참조) -- 이전엔 "3/3 import/library는 사람 판단 대기로 범위 밖"(C219 주석)이었던 잔여 스코프.
// line/col은 'export ' 접두어 길이만큼 밀리므로(같은 줄이지만 col이 다름) "identical to" 비교는
// 위치 필드를 재귀적으로 제거한 뒤 구조만 대조한다.
function stripPos(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPos);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "line" || k === "col") continue;
      out[k] = stripPos(v);
    }
    return out;
  }
  return node;
}

describe("Parser library()/export/import (no-op parse-through, C274)", () => {
  it("parses 'library(\"MyLib\")' as an ordinary CallExpr (same mechanism as indicator()/strategy())", () => {
    const script = parse('library("MyLib")');
    expect(script.body).toHaveLength(1);
    const stmt = script.body[0] as ExprStmt;
    expect(stmt.kind).toBe("ExprStmt");
    const call = stmt.expr as CallExpr;
    expect(call.kind).toBe("CallExpr");
    expect(call.callee).toMatchObject({ kind: "Identifier", name: "library" });
    expect(call.args).toHaveLength(1);
  });

  it("parses 'library(\"MyLib\", overlay=true)' with a keyword argument", () => {
    const script = parse('library("MyLib", overlay=true)');
    const call = (script.body[0] as ExprStmt).expr as CallExpr;
    expect(call.kwargs).toHaveLength(1);
    expect(call.kwargs[0]!.name).toBe("overlay");
  });

  it("parses 'export f(x) => x' identically to 'f(x) => x' (export is a pure no-op prefix)", () => {
    const exported = parse("export f(x) => x");
    const plain = parse("f(x) => x");
    expect(stripPos(exported.body)).toEqual(stripPos(plain.body));
  });

  it("parses 'export type Foo' identically to 'type Foo'", () => {
    const exported = parse("export type Foo\n    float value\n");
    const plain = parse("type Foo\n    float value\n");
    expect(stripPos(exported.body)).toEqual(stripPos(plain.body));
    expect((exported.body[0] as TypeDecl).kind).toBe("TypeDecl");
  });

  it("parses 'export enum Foo' identically to 'enum Foo'", () => {
    const exported = parse('export enum Direction\n    long = "Long Position"\n');
    const plain = parse('enum Direction\n    long = "Long Position"\n');
    expect(stripPos(exported.body)).toEqual(stripPos(plain.body));
    expect((exported.body[0] as EnumDecl).kind).toBe("EnumDecl");
  });

  it("parses 'export method' identically to 'method'", () => {
    const exported = parse("type Point\n    float x\nexport method area(Point p) => p.x\n");
    const plain = parse("type Point\n    float x\nmethod area(Point p) => p.x\n");
    expect(stripPos(exported.body)).toEqual(stripPos(plain.body));
    expect((exported.body[1] as MethodDecl).kind).toBe("MethodDecl");
  });

  it("parses 'export var' identically to 'var' (pine2py parser.py _parse_export also delegates var/varip)", () => {
    const exported = parse("export var float acc = 0.0");
    const plain = parse("var float acc = 0.0");
    expect(stripPos(exported.body)).toEqual(stripPos(plain.body));
  });

  it("drops a simple 'import user/lib/1 as alias' statement entirely from the AST body", () => {
    const script = parse('import user/lib/1 as mylib\nplot(close)');
    expect(script.body).toHaveLength(1);
    expect(script.body[0]).toMatchObject({ kind: "ExprStmt" });
  });

  it("drops 'import' without an 'as alias' clause", () => {
    const script = parse("import user/lib/1\nplot(close)");
    expect(script.body).toHaveLength(1);
  });

  it("drops 'import' with a two-segment path (no numeric version)", () => {
    const script = parse("import PineCoders/ta\nplot(close)");
    expect(script.body).toHaveLength(1);
  });

  it("drops 'import' with a hyphenated username in the path (C460, wild library path 'RVD-Projects/Types/3' — lexer tokenizes '-' as MINUS, not part of the identifier)", () => {
    const script = parse("import RVD-Projects/Types/3\nplot(close)");
    expect(script.body).toHaveLength(1);
    expect(script.body[0]).toMatchObject({ kind: "ExprStmt", expr: { callee: { name: "plot" } } });
  });

  it("drops 'import' with a hyphenated library segment and an 'as alias' clause", () => {
    const script = parse("import a-b-c/my-lib/2 as x\nplot(close)");
    expect(script.body).toHaveLength(1);
  });

  it("drops multiple consecutive import statements, keeping unrelated statements intact", () => {
    const script = parse(
      ["import a/b/1 as x", "import c/d/2 as y", 'library("L")', "plot(close)"].join("\n"),
    );
    expect(script.body).toHaveLength(2);
    expect(script.body[0]).toMatchObject({ kind: "ExprStmt", expr: { callee: { name: "library" } } });
    expect(script.body[1]).toMatchObject({ kind: "ExprStmt", expr: { callee: { name: "plot" } } });
  });

  it("parses a full library-script shape (library + export func + call, exact corpus pattern)", () => {
    const script = parse(
      ["library(\"MathUtils\")", "export addOne(float x) =>", "    x + 1.0", "y = addOne(close)"].join("\n"),
    );
    expect(script.body).toHaveLength(3);
    expect(script.body[0]).toMatchObject({ kind: "ExprStmt" });
    expect(script.body[1]).toMatchObject({ kind: "FuncDecl", name: "addOne" });
    expect(script.body[2]).toMatchObject({ kind: "Assignment" });
  });
});

describe("Parser comma-separated multi-statement lines ('a = 1, b = 2', pine2py parser.py _parse_statement_with_commas, C304)", () => {
  it("splits 'a = 1, b = 2, c = 3' into 3 separate Assignment statements", () => {
    const script = parse("a = 1, b = 2, c = 3");
    expect(script.body).toHaveLength(3);
    expect(script.body[0]).toMatchObject({ kind: "Assignment", name: "a" });
    expect(script.body[1]).toMatchObject({ kind: "Assignment", name: "b" });
    expect(script.body[2]).toMatchObject({ kind: "Assignment", name: "c" });
  });

  it("chains two 'var' declarations on one line ('var float x = na, var int y = na')", () => {
    const script = parse("var float x = na\nvar float bear_low = na, var int bear_low_time = na");
    expect(script.body).toHaveLength(3);
    expect(script.body[1]).toMatchObject({ kind: "VarDecl", persistent: true, name: "bear_low" });
    expect(script.body[2]).toMatchObject({ kind: "VarDecl", persistent: true, name: "bear_low_time" });
  });

  it("downgrades a bare (non-'var') segment following a 'var' segment to a plain Assignment (pine2py parity — no mixed-chain rejection, C304)", () => {
    const script = parse("var float a = na, b = 1.0");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]).toMatchObject({ kind: "VarDecl", persistent: true, name: "a" });
    expect(script.body[1]).toMatchObject({ kind: "Assignment", name: "b" });
  });

  it("chains a 'var' init with a ':=' reassignment ('var last = 1, last := last + 1')", () => {
    const script = parse("var last = 1, last := last + 1");
    expect(script.body).toHaveLength(2);
    expect(script.body[0]).toMatchObject({ kind: "VarDecl", persistent: true, name: "last" });
    expect(script.body[1]).toMatchObject({ kind: "Assignment", name: "last", operator: ":=" });
  });

  it("chains bare call-expression statements (discarded return values, 'line.delete(a), line.delete(b)')", () => {
    const script = parse("line.delete(a), line.delete(b), line.delete(c)");
    expect(script.body).toHaveLength(3);
    for (const stmt of script.body) expect(stmt.kind).toBe("ExprStmt");
  });

  it("chains statements calling functions with their own comma-separated args (inner commas stay inside the call, C304)", () => {
    const script = parse('hi = ta.highest(X, p), lo = ta.lowest(X, p)');
    expect(script.body).toHaveLength(2);
    const hi = script.body[0] as Assignment;
    expect(hi).toMatchObject({ kind: "Assignment", name: "hi" });
    expect((hi.value as CallExpr).args).toHaveLength(2);
    const lo = script.body[1] as Assignment;
    expect(lo).toMatchObject({ kind: "Assignment", name: "lo" });
  });

  it("applies inside an indented block (UDF body), not just top-level", () => {
    const script = parse(["minimax(X, p) =>", "    hi = ta.highest(X, p), lo = ta.lowest(X, p)", "    hi - lo"].join("\n"));
    const fn = script.body[0] as FuncDecl;
    expect(fn.kind).toBe("FuncDecl");
    expect(fn.body).toHaveLength(3);
    expect(fn.body[0]).toMatchObject({ kind: "Assignment", name: "hi" });
    expect(fn.body[1]).toMatchObject({ kind: "Assignment", name: "lo" });
  });

  it("applies inside an if-block body", () => {
    const script = parse(["if close > open", "    a = 1, b = 2"].join("\n"));
    const ifStmt = script.body[0] as IfStmt;
    expect(ifStmt.thenBody).toHaveLength(2);
    expect(ifStmt.thenBody[0]).toMatchObject({ kind: "Assignment", name: "a" });
    expect(ifStmt.thenBody[1]).toMatchObject({ kind: "Assignment", name: "b" });
  });

  it("does NOT chain across a real newline (comma-less consecutive lines stay independent statements)", () => {
    const script = parse("a = 1\nb = 2\n");
    expect(script.body).toHaveLength(2);
  });

  it("leaves a lone statement (no trailing comma) unaffected", () => {
    const script = parse("a = 1");
    expect(script.body).toHaveLength(1);
  });

  it("chains a tuple destructure with a following plain statement ('[a, b] = f(), c = 1')", () => {
    const script = parse("f() =>\n    [1, 2]\n[a, b] = f(), c = 1");
    expect(script.body).toHaveLength(3);
    expect(script.body[1]).toMatchObject({ kind: "TupleDestructure" });
    expect(script.body[2]).toMatchObject({ kind: "Assignment", name: "c" });
  });

  // C319: pine2py의 `_parse_statement_with_commas`는 `현재 토큰의 물리 줄 === 시작 줄`로 좁게
  // 한정해 트레일링 쉼표가 실제 NEWLINE 없이 다음 물리 줄로 이어지는 wild 실사용(예:
  // `[tid_001,out_001]=feed(a), [tid_002,out_002]=feed(out_001),` 를 여러 줄에 걸쳐 나열)을
  // 지원하지 못한다(python 직접 실행으로 동일 크래시 재현, DIVERGENCES #125) — pine2js는 물리
  // 줄 제한 자체를 없애 여러 physical line에 걸친 체인도 지원한다.
  it("chains statements across multiple physical lines via trailing comma (COMMA is a lexer CONTINUATION_OP)", () => {
    const script = parse("a = 1, b = 2,\nc = 3, d = 4");
    expect(script.body).toHaveLength(4);
    expect(script.body[0]).toMatchObject({ kind: "Assignment", name: "a" });
    expect(script.body[1]).toMatchObject({ kind: "Assignment", name: "b" });
    expect(script.body[2]).toMatchObject({ kind: "Assignment", name: "c" });
    expect(script.body[3]).toMatchObject({ kind: "Assignment", name: "d" });
  });

  it("chains across more than two physical lines (wild feed()-style 10-line/40-statement pattern, scaled down)", () => {
    const script = parse("a = 1, b = 2,\nc = 3, d = 4,\ne = 5, f = 6");
    expect(script.body).toHaveLength(6);
    expect(script.body[5]).toMatchObject({ kind: "Assignment", name: "f" });
  });

  it("chains across multiple physical lines inside an indented block too", () => {
    const script = parse(["if close > open", "    a = 1, b = 2,", "    c = 3"].join("\n"));
    const ifStmt = script.body[0] as IfStmt;
    expect(ifStmt.thenBody).toHaveLength(3);
    expect(ifStmt.thenBody[2]).toMatchObject({ kind: "Assignment", name: "c" });
  });
});

// ── switch case 본문/case-arm 나열의 쉼표 지원 (C319) ──────────────────────
// pine2py `_parse_block_or_expr`는 단일 표현식만 파싱해 case 본문 안 쉼표 문장 나열
// (`=> sideEffect(), returnVal`)도, 한 줄에 여러 case arm을 나열하는 실사용
// (`0 => "a", 1 => "b"`)도 지원하지 못한다(둘 다 python 직접 실행으로 동일 "Unexpected token:
// COMMA" 크래시 재현, DIVERGENCES #125) — 이 두 문법은 같은 위치의 쉼표를 서로 다른 의미로
// 쓰므로 parseBlockOrExpr의 lookahead(다음이 `expr FAT_ARROW`인가)로 구분한다.
describe("Parser switch case comma sugar (case-body statement chains + one-line multi-arm, C319)", () => {
  it("parses an inline (non-indented) multi-statement case body chained by commas", () => {
    const script = parse(["switch x", '    1 => runtime.error("boom"), na', "    => 0"].join("\n"));
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.cases[0]!.body).toHaveLength(2);
    expect(stmt.cases[0]!.body[0]).toMatchObject({ kind: "ExprStmt" });
    expect((stmt.cases[0]!.body[0] as ExprStmt).expr).toMatchObject({ kind: "CallExpr" });
    expect((stmt.cases[0]!.body[1] as ExprStmt).expr).toMatchObject({ kind: "NaLiteral" });
  });

  it("parses multiple case arms listed on one physical line, comma-separated", () => {
    const script = parse(["switch x", '    0 => "a", 1 => "b"', "    => 0"].join("\n"));
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.cases).toHaveLength(3);
    expect(stmt.cases[0]!.values).toMatchObject([{ kind: "NumberLiteral", value: 0 }]);
    expect((stmt.cases[0]!.body[0] as ExprStmt).expr).toMatchObject({ kind: "StringLiteral", value: "a" });
    expect(stmt.cases[1]!.values).toMatchObject([{ kind: "NumberLiteral", value: 1 }]);
    expect((stmt.cases[1]!.body[0] as ExprStmt).expr).toMatchObject({ kind: "StringLiteral", value: "b" });
    expect(stmt.cases[2]!.values).toBeNull(); // default
  });

  it("parses many one-line arms ending in a bare default arm (wild 6-arm pattern)", () => {
    const script = parse(
      ["switch state", '    0 => "IDLE", 1 => "PRE", 2 => "LONG", => "UNKNOWN"'].join("\n"),
    );
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.cases).toHaveLength(4);
    expect(stmt.cases[3]!.values).toBeNull();
    expect((stmt.cases[3]!.body[0] as ExprStmt).expr).toMatchObject({ kind: "StringLiteral", value: "UNKNOWN" });
  });

  it("does not confuse a multi-statement body's trailing value with a new case arm when it's the last case", () => {
    const script = parse(["switch x", '    1 => "VWMA"', '    => runtime.error("bad"), na'].join("\n"));
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.cases).toHaveLength(2);
    expect(stmt.cases[1]!.body).toHaveLength(2);
  });

  it("still supports multi-value case lists unaffected ('1, 2, 3 => body') alongside one-line multi-arm", () => {
    const script = parse(["switch x", '    1, 2 => "lo", 3 => "hi"', "    => 0"].join("\n"));
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.cases).toHaveLength(3);
    expect(stmt.cases[0]!.values).toHaveLength(2);
    expect(stmt.cases[1]!.values).toMatchObject([{ kind: "NumberLiteral", value: 3 }]);
  });

  it("chains a comma-separated multi-statement inline UDF body (no case-arm ambiguity to worry about)", () => {
    const script = parse('f() => runtime.error("x"), na');
    const fn = script.body[0] as FuncDecl;
    expect(fn.body).toHaveLength(2);
    expect((fn.body[1] as ExprStmt).expr).toMatchObject({ kind: "NaLiteral" });
  });
});

// ── ANNOTATION 토큰이 INDENT 블록 오프너를 막지 않는다 (C317) ──────────────
// `//@variable`류 TV 공식 auto-doc 주석은 렉서가 NEWLINE 없이 단독 토큰으로 내보낸다
// (lexer.ts tokenizeLine L81-84) — if/for/while/switch/type/enum/UDF 등 INDENT를 여는
// 모든 지점이 조건-NEWLINE과 실제 INDENT 사이(또는 블록 내부 문장 사이)에 낀 이 토큰을
// 건너뛰지 못하면 parseBlock()의 `if (this.match("INDENT"))`가 매치 실패로 본문을 조용히
// []로 반환하는 실제 파서 버그가 있었다(C316이 발견, wild corpus_scan 3파일에서 재현).
// skipAnnotations()로 해소.
describe("ANNOTATION tokens do not block INDENT-opening constructs (C317)", () => {
  it("skips a //@variable annotation before the first statement of an if-body", () => {
    const script = parse(["if close > open", "    //@variable a note", "    x := 1"].join("\n"));
    const stmt = script.body[0] as IfStmt;
    expect(stmt.thenBody).toHaveLength(1);
    expect(stmt.thenBody[0]).toMatchObject({ kind: "Assignment", name: "x" });
  });

  it("skips an annotation between two statements inside an if-body", () => {
    const script = parse(["if close > open", "    x := 1", "    //@variable a note", "    y := 2"].join("\n"));
    const stmt = script.body[0] as IfStmt;
    expect(stmt.thenBody).toHaveLength(2);
    expect(stmt.thenBody[1]).toMatchObject({ kind: "Assignment", name: "y" });
  });

  it("skips an annotation before the first statement of an else-body", () => {
    const script = parse(["if close > open", "    x := 1", "else", "    //@variable note", "    x := 2"].join("\n"));
    const stmt = script.body[0] as IfStmt;
    expect(stmt.elseBody).toHaveLength(1);
    expect(stmt.elseBody![0]).toMatchObject({ kind: "Assignment", name: "x" });
  });

  it("skips an annotation before the first statement of an else-if body", () => {
    const script = parse(
      ["if close > open", "    x := 1", "else if close < open", "    //@variable note", "    x := 2"].join("\n"),
    );
    const stmt = script.body[0] as IfStmt;
    expect(stmt.elifClauses).toHaveLength(1);
    expect(stmt.elifClauses[0]!.body).toHaveLength(1);
  });

  it("skips an annotation before the first statement of a for-body", () => {
    const script = parse(["for i = 0 to 9", "    //@variable note", "    x := i"].join("\n"));
    const forStmt = script.body[0] as ForStmt;
    expect(forStmt.body).toHaveLength(1);
    expect(forStmt.body[0]).toMatchObject({ kind: "Assignment", name: "x" });
  });

  it("skips an annotation before the first statement of a while-body", () => {
    const script = parse(["while x < 10", "    //@variable note", "    x := x + 1"].join("\n"));
    const whileStmt = script.body[0] as WhileStmt;
    expect(whileStmt.body).toHaveLength(1);
  });

  it("skips an annotation before the first case of a switch block", () => {
    const script = parse(["switch x", "    //@variable note", "    1 => 1", "    => 0"].join("\n"));
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.cases).toHaveLength(2);
  });

  it("skips an annotation between two switch cases", () => {
    const script = parse(["switch x", "    1 => 1", "    //@variable note", "    2 => 2", "    => 0"].join("\n"));
    const stmt = script.body[0] as SwitchStmt;
    expect(stmt.cases).toHaveLength(3);
  });

  it("skips an annotation before the first field of a type declaration", () => {
    const script = parse(["type Point", "    //@field x coordinate", "    float x"].join("\n"));
    const decl = script.body[0] as TypeDecl;
    expect(decl.fields).toHaveLength(1);
    expect(decl.fields[0]!.name).toBe("x");
  });

  it("skips an annotation between two type declaration fields", () => {
    const script = parse(["type Point", "    float x", "    //@field y coordinate", "    float y"].join("\n"));
    const decl = script.body[0] as TypeDecl;
    expect(decl.fields).toHaveLength(2);
    expect(decl.fields[1]!.name).toBe("y");
  });

  it("skips an annotation before the first member of an enum declaration", () => {
    const script = parse(["enum Dir", "    //@variable up", "    Up"].join("\n"));
    const decl = script.body[0] as EnumDecl;
    expect(decl.members).toHaveLength(1);
    expect(decl.members[0]!.name).toBe("Up");
  });

  it("skips an annotation between two enum members", () => {
    const script = parse(["enum Dir", "    Up", "    //@variable down", "    Down"].join("\n"));
    const decl = script.body[0] as EnumDecl;
    expect(decl.members).toHaveLength(2);
    expect(decl.members[1]!.name).toBe("Down");
  });

  it("skips an annotation before the indented body of a UDF declaration", () => {
    const script = parse(["f(x) =>", "    //@variable note", "    x + 1"].join("\n"));
    const fn = script.body[0] as FuncDecl;
    expect(fn.body).toHaveLength(1);
  });

  it("reproduces the exact wild-corpus pattern that crashed before the fix (C316/C317)", () => {
    const src = [
      "if barstate.islastconfirmedhistory",
      "    //@variable A table displaying strategy information.",
      "    var table dashboard = table.new(position.top_right, 2, 10)",
    ].join("\n");
    const script = parse(src);
    const stmt = script.body[0] as IfStmt;
    expect(stmt.thenBody).toHaveLength(1);
    expect(stmt.thenBody[0]).toMatchObject({ kind: "VarDecl", name: "dashboard" });
  });
});
