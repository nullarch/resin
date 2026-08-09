import { describe, it, expect } from "vitest";
import { tokenize } from "../../src/transpiler/lexer";

function types(source: string): string[] {
  return tokenize(source).map((t) => t.type);
}

describe("Lexer", () => {
  it("tokenizes integer and float numbers", () => {
    const toks = tokenize("0.0\n3\n1.5e-3");
    const numbers = toks.filter((t) => t.type === "NUMBER").map((t) => t.value);
    expect(numbers).toEqual(["0.0", "3", "1.5e-3"]);
  });

  it("tokenizes identifiers vs keywords", () => {
    const toks = tokenize("acc var na");
    expect(toks.map((t) => t.type)).toEqual(["IDENTIFIER", "VAR", "NA", "NEWLINE", "EOF"]);
  });

  it("tokenizes := and = distinctly", () => {
    const toks = tokenize("acc := 1\nacc = 2");
    const ops = toks.filter((t) => t.type === "WALRUS" || t.type === "ASSIGN").map((t) => t.type);
    expect(ops).toEqual(["WALRUS", "ASSIGN"]);
  });

  it("skips full-line comments entirely", () => {
    const toks = tokenize("// a comment\nacc = 1");
    expect(toks[0]!.type).toBe("IDENTIFIER");
  });

  it("emits ANNOTATION token for //@ pragmas", () => {
    const toks = tokenize("//@version=5\nacc = 1");
    expect(toks[0]).toMatchObject({ type: "ANNOTATION", value: "//@version=5" });
  });

  it("emits NEWLINE between statements", () => {
    expect(types("acc = 1\nacc = 2")).toEqual([
      "IDENTIFIER",
      "ASSIGN",
      "NUMBER",
      "NEWLINE",
      "IDENTIFIER",
      "ASSIGN",
      "NUMBER",
      "NEWLINE",
      "EOF",
    ]);
  });

  it("tokenizes string literals", () => {
    const toks = tokenize('indicator("smoke")');
    const str = toks.find((t) => t.type === "STRING");
    expect(str?.value).toBe("smoke");
  });

  it("always terminates with EOF", () => {
    const toks = tokenize("acc = 1");
    expect(toks[toks.length - 1]!.type).toBe("EOF");
  });

  it("does not emit trailing NEWLINE before EOF for blank source", () => {
    expect(types("")).toEqual(["EOF"]);
  });

  it("tokenizes dotted member calls (ta.sma)", () => {
    const toks = tokenize("ta.sma(close, 3)");
    expect(toks.map((t) => t.type)).toEqual([
      "IDENTIFIER",
      "DOT",
      "IDENTIFIER",
      "LPAREN",
      "IDENTIFIER",
      "COMMA",
      "NUMBER",
      "RPAREN",
      "NEWLINE",
      "EOF",
    ]);
  });

  it("tokenizes the smoke_var_sma.pine source without throwing", () => {
    const source = [
      "//@version=5",
      'indicator("smoke")',
      "var float acc = 0.0",
      "acc := acc + close",
      "sma3 = ta.sma(close, 3)",
      "var float __obs_sma3 = na",
      "__obs_sma3 := sma3",
    ].join("\n");
    const toks = tokenize(source);
    expect(toks[toks.length - 1]!.type).toBe("EOF");
    expect(toks.some((t) => t.type === "VAR")).toBe(true);
    expect(toks.some((t) => t.type === "WALRUS")).toBe(true);
  });
});

describe("Lexer - INDENT/DEDENT", () => {
  it("emits INDENT on increased indentation and DEDENT when it drops back", () => {
    const src = "if true\n    x = 1\ny = 2";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "DEDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });

  it("emits one DEDENT per level when indentation drops across multiple levels at once", () => {
    const src = "if true\n    if false\n        x = 1\ny = 2";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "DEDENT", "DEDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });

  it("flushes trailing DEDENTs at EOF for an unclosed indented block", () => {
    const src = "if true\n    x = 1";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  it("treats a tab as 4-width indentation, equivalent to 4 spaces", () => {
    const spaces = types("if true\n    x = 1\ny = 2");
    const tabs = types("if true\n\tx = 1\ny = 2");
    expect(tabs).toEqual(spaces);
  });

  it("does not let blank lines between differently-indented lines disturb the indent stack", () => {
    const src = "if true\n\n    x = 1";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  it("suppresses INDENT/DEDENT while inside a multi-line parenthesized call", () => {
    const src = "sma3 = ta.sma(\n    close,\n    3)\ny = 1";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER", "DOT", "IDENTIFIER", "LPAREN",
      "IDENTIFIER", "COMMA",
      "NUMBER", "RPAREN", "NEWLINE",
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });

  it("suppresses INDENT/DEDENT while inside a multi-line bracketed index", () => {
    const src = "x = arr[\n    1]\ny = 1";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER", "LBRACKET",
      "NUMBER", "RBRACKET", "NEWLINE",
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });

  // wild2 코퍼스 실측(C755, "예상치 못한 들여쓰기 블록" 클러스터): `//@version=5` 다음
  // `indicator(...)` 등 파일의 첫 실질 문장 줄 앞에 복붙 아티팩트로 남은 선행 공백 —
  // tv_verdict accept(TV 실제 컴파일 통과) 확인. 첫 문장 앞에는 블록 헤더가 존재할 수
  // 없으므로 그 폭은 기준선(0)으로 흡수돼야 하고 INDENT를 유발하면 안 된다.
  it("does not treat leading whitespace on the file's first statement line as INDENT", () => {
    const src = "  x = 1\ny = 2";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });

  it("still tracks real INDENT/DEDENT for later blocks after an indented first statement", () => {
    const src = "  x = 1\nif true\n    y = 2\nz = 3";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "DEDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });

  it("tokenizes a version-pragma + indented indicator() header without throwing (wild copy-paste artifact)", () => {
    const src = ['//@version=5', '  indicator("x")', "acc = 1"].join("\n");
    expect(types(src)).toEqual([
      "ANNOTATION",
      "INDICATOR", "LPAREN", "STRING", "RPAREN", "NEWLINE",
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });
});

describe("Lexer - line continuation", () => {
  it("continues the line when it ends in a trailing binary operator (no NEWLINE)", () => {
    const src = "x = 1 +\n    2";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "NUMBER", "PLUS", "NUMBER", "NEWLINE", "EOF",
    ]);
  });

  it("continues across multiple trailing-operator lines (ternary ? and :)", () => {
    const src = "y = cond ?\n    1 :\n    2";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER", "QUESTION",
      "NUMBER", "COLON",
      "NUMBER", "NEWLINE", "EOF",
    ]);
  });

  it("merges a line starting with 'and'/'or' into the previous line, dropping the NEWLINE between them", () => {
    const src = "cond = a\n    and b";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER", "AND", "IDENTIFIER", "NEWLINE", "EOF",
    ]);
  });

  it("leading-continuation only drops the previous NEWLINE, not an open block's indent stack", () => {
    const src = "if true\n    x = 1\nor y";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "NUMBER",
      "OR", "IDENTIFIER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  // wild 코퍼스 실측(C316, "예상치 못한 들여쓰기 블록" 클러스터): 삼항/산술/비교 표현식을
  // 여러 줄로 나눌 때 연산자를 "다음 줄 맨 앞"에 두는 정렬 스타일 — 트레일링 연산자가 없어
  // 기존 LEADING_CONTINUATION_KEYWORDS("or"/"and")만으로는 못 잡던 케이스.
  it("merges a line starting with '?' into the previous line even without a trailing operator", () => {
    const src = "y = cond\n    ? 1\n    : 2";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER",
      "QUESTION", "NUMBER",
      "COLON", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });

  it("merges a line starting with '+' into the previous line (leading string/arithmetic concatenation)", () => {
    const src = 'msg = "a"\n    + "b"';
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "STRING",
      "PLUS", "STRING", "NEWLINE",
      "EOF",
    ]);
  });

  it("merges a line starting with '==' into the previous line (leading comparison)", () => {
    const src = "ok = input.string()\n    == 'Wicks'";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER", "DOT", "IDENTIFIER", "LPAREN", "RPAREN",
      "EQ", "STRING", "NEWLINE",
      "EOF",
    ]);
  });

  // wild2 코퍼스 실측(C661, "예상치 못한 들여쓰기 블록" 클러스터): 튜플 디스트럭처/단순 대입의
  // '='를 다음 줄 맨 앞으로 내려쓰는 정렬 스타일 — request.security/request.security_lower_tf
  // 다중 반환 대입에서 다수 확인(`[a, b]\n    = request.security(...)`).
  it("merges a line starting with '=' into the previous line (leading assignment, tuple destructure)", () => {
    const src = "[a, b]\n    = f()";
    expect(types(src)).toEqual([
      "LBRACKET", "IDENTIFIER", "COMMA", "IDENTIFIER", "RBRACKET",
      "ASSIGN", "IDENTIFIER", "LPAREN", "RPAREN", "NEWLINE",
      "EOF",
    ]);
  });

  it("does NOT confuse a leading '=>' (FAT_ARROW) with leading '=' continuation", () => {
    const src = "f(x)\n    => x + 1";
    expect(types(src)).not.toContain("ASSIGN");
  });

  // wild2 코퍼스 실측(C757, next_hint(C756)): `f_sec(_market ,_res, _exp)\n     => request.security(...)`
  // 류 단문 UDF 정의의 '=>'를 다음 줄 맨 앞에 두는 정렬 스타일(3d1d6f1ee9ef/65f8c8a2a893,
  // tv_verdict accept, 동일 템플릿 2건). 단 FAT_ARROW는 ASSIGN/비교연산자와 달리 무조건 리딩
  // continuation으로 신뢰할 수 없다(아래 두 테스트 참조 — switch default arm과 충돌, 최초 구현이
  // wild 52건 regression을 냄). 직전 실토큰이 RPAREN(파라미터 목록을 막 닫은 시그니처)이고 폭이
  // 그 시그니처보다 늘어난 경우만 병합한다 — 이 조건에서만 INDENT를 유발하지 않고 단일 논리
  // 줄로 합쳐져야 한다.
  it("merges a line starting with '=>' into the previous line (leading single-line UDF arrow)", () => {
    const src = "f(x)\n    => x + 1";
    expect(types(src)).toEqual([
      "IDENTIFIER", "LPAREN", "IDENTIFIER", "RPAREN",
      "FAT_ARROW", "IDENTIFIER", "PLUS", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });

  // wild2 코퍼스 실측(C757): subject 없는 `switch`의 유일한 첫 case-arm이 default arm(레이블
  // 없는 bare `=> expr`)일 때(5f4a8c500164/a6ae41034f24), 그 arm은 switch 헤더보다 폭이 늘어나도
  // 진짜 INDENT(새 블록의 첫 문장)이지 continuation이 아니다 — 직전 실토큰이 SWITCH(RPAREN
  // 아님)라 폭 조건만으론 구분 불가했던 실제 regression을 재현.
  it("does NOT merge a leading '=>' switch default-arm line (would misparse as continuation of the switch header)", () => {
    const src = 'mode = switch\n    => "Static"';
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "SWITCH", "NEWLINE",
      "INDENT", "FAT_ARROW", "STRING", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  // wild2 코퍼스 실측(C757): 중첩 블록 안에서는 실제 UDF 시그니처(top-level 전용)가 나올 수
  // 없으므로 이 시나리오 자체가 비현실적이다 — 대신 폭이 "늘지 않는" 리딩 FAT_ARROW는 항상
  // 거부돼야 함을 확인(직전 실토큰이 RPAREN이어도 폭이 그대로면 switch arm과 동일 위험군).
  it("does NOT merge a leading '=>' at the same width as the preceding RPAREN-ending line (no indent increase)", () => {
    const src = "if true\n    f(x)\n    => x + 1";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "LPAREN", "IDENTIFIER", "RPAREN", "NEWLINE",
      "FAT_ARROW", "IDENTIFIER", "PLUS", "NUMBER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  // wild2 코퍼스 실측(C760, next_hint(C759)): `s = switch\n    cond1\n                => "Min"\n
  // cond2 => "D"\n    => "X"`류(75d378af6ded) switch case-condition을 여러 줄로
  // 쪼개고 '=>'를 다음 줄 맨 앞(조건식보다 더 깊은 폭)에 두는 정렬 스타일 — 직전 실토큰이
  // RPAREN이 아니라 산술/비교 연산자로 끝나는 case-condition이라 C757의 RPAREN 전용 가드로는
  // 못 잡는다. "직전 실토큰이 속한 물리 줄에 SWITCH 토큰이 있는가"로 판별을 바꿔 헤더 자신(진짜
  // 새 INDENT 필요)과 이미 헤더를 지난 case-condition 줄(continuation 허용)을 구분.
  it("merges a leading '=>' that continues a multi-line switch case-condition (deeper than the condition's own width)", () => {
    const src = "s = switch\n    a and b\n                 => 1\n    c => 2";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "SWITCH", "NEWLINE",
      "INDENT", "IDENTIFIER", "AND", "IDENTIFIER",
      "FAT_ARROW", "NUMBER", "NEWLINE",
      "IDENTIFIER", "FAT_ARROW", "NUMBER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  // C760 regression guard: subject-full switch(subject 있는 switch, `switch x`)의 유일한 첫 arm이
  // default arm(레이블 없는 bare `=> expr`)일 때도 C757의 subject-없는 switch와 동일하게 진짜
  // 새 INDENT여야 한다 — "직전 실토큰 != SWITCH"로만 넓히면 이 케이스(직전 실토큰이 subject
  // 식별자라 SWITCH가 아님)를 오분류해 case 자체가 통째로 소실되는 regression을 실측 확인했다.
  it("does NOT merge a leading '=>' subject-full switch bare-first-arm line (header line itself, not a case-condition continuation)", () => {
    const src = 'mode = switch x\n    => "Static"';
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "SWITCH", "IDENTIFIER", "NEWLINE",
      "INDENT", "FAT_ARROW", "STRING", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  // C760 crash guard: the SWITCH-header-line scan added above walks backward from the token
  // immediately preceding this line; if a leading '=>' is literally the first token in the
  // whole file, that walk-back has nothing to scan (lastRealIdx === -1) — must not index
  // this.tokens[-1].
  it("does not crash on a leading '=>' with no preceding tokens at all (start of file)", () => {
    expect(() => types('=> "x"')).not.toThrow();
  });

  it("leading-'='-continuation only drops the previous NEWLINE, not an open block's indent stack", () => {
    const src = "if true\n    [a, b]\n    = f()";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "LBRACKET", "IDENTIFIER", "COMMA", "IDENTIFIER", "RBRACKET",
      "ASSIGN", "IDENTIFIER", "LPAREN", "RPAREN", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  it("does NOT treat a leading '-' as continuation (no wild evidence, MINUS excluded by curation)", () => {
    const src = "x = 1\n    -y";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "INDENT", "MINUS", "IDENTIFIER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  it("leading-symbol-continuation only drops the previous NEWLINE, not an open block's indent stack", () => {
    const src = "if true\n    x = 1\n    + 2";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "NUMBER",
      "PLUS", "NUMBER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  // wild2 코퍼스 실측(C756, next_hint(C755) "예상치 못한 들여쓰기 블록" 잔여 재분류):
  // `bool ok = (a - b)\n    >= threshold`류 비교연산자를 다음 줄 맨 앞에 두는 정렬 스타일 —
  // tv_verdict accept(7e884bbec405) 확인. `==`(EQ) 리딩과 동일 근거(비교 연산자로 시작하는
  // 줄이 새 top-level 문장일 수 없음)로 LT/GT/LTE/GTE/NEQ 전부 대칭 확장.
  it.each([
    ["<", "LT"],
    [">", "GT"],
    ["<=", "LTE"],
    [">=", "GTE"],
    ["!=", "NEQ"],
  ] as const)("merges a line starting with '%s' into the previous line (leading comparison)", (op, tokenType) => {
    const src = `ok = a\n    ${op} b`;
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER",
      tokenType, "IDENTIFIER", "NEWLINE",
      "EOF",
    ]);
  });

  // wild2 코퍼스 실측(C756, next_hint(C755)): `and`/`or`가 공백 없이 바로 괄호를 여는
  // 정렬 스타일(`and( vixrsiCondBuy or not vixrsiOn)`) — 공백 split 기반 firstWord 추출은
  // "and("를 통째로 한 단어로 뽑아 LEADING_CONTINUATION_KEYWORDS 매칭을 놓쳤다(5a13dcf4bcfe,
  // tv_verdict accept). 식별자 문자 클래스 기반 토큰화로 교체해 해소.
  it("merges a line starting with 'and(' (no space before paren) into the previous line", () => {
    const src = "cond = a\n    and(b or c)";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER",
      "AND", "LPAREN", "IDENTIFIER", "OR", "IDENTIFIER", "RPAREN", "NEWLINE",
      "EOF",
    ]);
  });

  it("merges a line starting with 'or(' (no space before paren) into the previous line", () => {
    const src = "cond = a\n    or(b and c)";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER",
      "OR", "LPAREN", "IDENTIFIER", "AND", "IDENTIFIER", "RPAREN", "NEWLINE",
      "EOF",
    ]);
  });

  it("does NOT treat an identifier merely starting with 'and'/'or' as the continuation keyword (e.g. 'android', 'origin')", () => {
    const src = "x = 1\n    android = 2";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  // wild2 코퍼스 실측(C758, next_hint(C757)): `dataBuilder.new()\n  .add(...)\n  .add(...)`류
  // 메서드 체인의 '.'를 다음 줄 맨 앞에 두는 정렬 스타일(861c5a4caf83/cff5a2f3cdcb, tv_verdict
  // accept). '.'로 시작하는 줄은 문법상 항상 선행 표현식의 멤버/메서드 접근이라 새 top-level
  // 문장일 수 없다(FAT_ARROW 같은 이중 의미가 없어 폭/직전토큰 가드 불필요).
  it("merges a line starting with '.' into the previous line (leading dot-chain continuation)", () => {
    const src = "x = a.new()\n  .add(1)\n  .add(2)";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "IDENTIFIER", "DOT", "IDENTIFIER", "LPAREN", "RPAREN",
      "DOT", "IDENTIFIER", "LPAREN", "NUMBER", "RPAREN",
      "DOT", "IDENTIFIER", "LPAREN", "NUMBER", "RPAREN", "NEWLINE",
      "EOF",
    ]);
  });

  it("leading-dot-continuation only drops the previous NEWLINE, not an open block's indent stack", () => {
    const src = "if true\n    x = a.new()\n    .add(1)";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "IDENTIFIER", "DOT", "IDENTIFIER", "LPAREN", "RPAREN",
      "DOT", "IDENTIFIER", "LPAREN", "NUMBER", "RPAREN", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  // 실제 스캐너(readNumber)는 "."+숫자를 NUMBER 리터럴로 읽는다(예: ".5") — peekLeadingTokenType이
  // 이를 DOT 리딩 continuation으로 오분류해 앞 줄에 강제 병합하면 안 된다.
  it("does NOT treat a leading '.5' decimal literal as DOT continuation (real scanner reads it as NUMBER)", () => {
    const src = "x = 1\n    .5";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "INDENT", "NUMBER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });

  // wild2 코퍼스 실측(C759, next_hint(C758)): `a = 0, b = 1, ...\n ,      c = 2, d = 3, ...`류
  // 쉼표-구분 다중 대입문(parser.ts parseStatementWithCommas, "완료된 문장 직후 COMMA는 물리
  // 줄과 무관하게 항상 문장 구분자")을 트레일링이 아니라 리딩 위치에 쉼표를 두고 다음 줄로
  // 내려쓰는 정렬 스타일(fdee238934d1, tv_verdict accept). ','로 시작하는 줄은 문법상 항상
  // 선행 완료된 문장/원소 뒤의 구분자라 새 top-level 문장을 열 수 없다(DOT과 동일 근거, 폭/
  // 직전토큰 가드 불필요).
  it("merges a line starting with ',' into the previous line (leading comma continuation, multi-assignment)", () => {
    const src = "a = 1\n    , b = 2";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "NUMBER",
      "COMMA", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });

  it("leading-comma-continuation only drops the previous NEWLINE, not an open block's indent stack", () => {
    const src = "if true\n    a = 1\n    , b = 2";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT", "IDENTIFIER", "ASSIGN", "NUMBER",
      "COMMA", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "DEDENT", "EOF",
    ]);
  });
});

describe("Lexer - mixed tab+space indentation (DIVERGENCES.md #87)", () => {
  it("does not lose tokens on a tab-then-space indented line (raw char offset, not visual width, positions the scan)", () => {
    // pine2py's lexer sets pos = visual width (tab=4) directly as a raw string index, so on
    // "\t x = 1" (tab+space = width 5 but only 2 raw chars before 'x') it skips past "x = "
    // entirely and mis-tokenizes the trailing "1" as if it started the line (DIVERGENCES #87).
    // pine2js tracks rawOffset separately from width and must recover the full statement.
    const src = "if true\n\t x = 1\n\t y = 2\nz = 3";
    expect(types(src)).toEqual([
      "IF", "BOOL", "NEWLINE",
      "INDENT",
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "DEDENT", "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });
});

describe("Lexer - string literal edge cases", () => {
  it("does not treat // inside a string literal as a comment start (URL-like strings)", () => {
    const toks = tokenize('a = "http://example.com//path"\nplot(a)');
    const str = toks.find((t) => t.type === "STRING");
    expect(str?.value).toBe("http://example.com//path");
  });

  it("treats a backslash-escaped quote as string content, not the closing quote", () => {
    const toks = tokenize('a = "He said \\"hi\\""\nb = 1');
    const str = toks.find((t) => t.type === "STRING");
    expect(str?.value).toBe('He said \\"hi\\"');
    // confirms the scan resynced correctly and did not consume the next statement
    expect(types('a = "He said \\"hi\\""\nb = 1')).toEqual([
      "IDENTIFIER", "ASSIGN", "STRING", "NEWLINE",
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });
});

describe("Lexer - block comments", () => {
  it("spans a /* */ block comment across more than two lines", () => {
    const src = "/* line1\nline2\nline3 */\nx = 1";
    expect(types(src)).toEqual(["IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE", "EOF"]);
  });

  it("resumes tokenizing on the same line after an inline /* */ block comment", () => {
    const src = "x = 1 /* inline */ + 2\ny = 3";
    expect(types(src)).toEqual([
      "IDENTIFIER", "ASSIGN", "NUMBER", "PLUS", "NUMBER", "NEWLINE",
      "IDENTIFIER", "ASSIGN", "NUMBER", "NEWLINE",
      "EOF",
    ]);
  });
});

describe("Lexer - operators and literals", () => {
  it("tokenizes compound assignment operators distinctly from ASSIGN", () => {
    const toks = types("x += 1\nx -= 2\nx *= 3\nx /= 4\nx %= 5");
    expect(toks.filter((t) => t !== "IDENTIFIER" && t !== "NUMBER" && t !== "NEWLINE" && t !== "EOF")).toEqual([
      "PLUS_ASSIGN", "MINUS_ASSIGN", "STAR_ASSIGN", "SLASH_ASSIGN", "PERCENT_ASSIGN",
    ]);
  });

  it("tokenizes -> as ARROW distinctly from => FAT_ARROW", () => {
    const toks = tokenize("f(x) => x + 1\ng(x) -> int");
    expect(toks.some((t) => t.type === "FAT_ARROW")).toBe(true);
    expect(toks.some((t) => t.type === "ARROW")).toBe(true);
  });

  it("tokenizes #RRGGBB and #RRGGBBAA color literals", () => {
    const toks = tokenize("c = #FF0000\nd = #ff00ffAA");
    const colors = toks.filter((t) => t.type === "COLOR").map((t) => t.value);
    expect(colors).toEqual(["#FF0000", "#ff00ffAA"]);
  });

  it("tokenizes leading-dot and trailing-dot numbers (.5 and 5.)", () => {
    const toks = tokenize("a = .5\nb = 5.");
    const numbers = toks.filter((t) => t.type === "NUMBER").map((t) => t.value);
    expect(numbers).toEqual([".5", "5."]);
  });
});

// C614: 닫는 따옴표를 못 찾으면 다음 물리 줄로 이어 스캔(wild tooltip 문자열 관용구, "예상치
// 못한 들여쓰기 블록" 클러스터 최다 원인, corpus_wild 37/112건). pine2py 동일 지점도 줄 단위
// 한정이라(직접 실행 확인) 오라클 대조 불가 — hand-verified 전용, DIVERGENCES 등재.
describe("Lexer - multi-line strings", () => {
  it("continues a double-quoted string onto the next physical line when unclosed", () => {
    const toks = tokenize('tt = "Line 1\nLine 2"');
    const str = toks.find((t) => t.type === "STRING");
    expect(str?.value).toBe("Line 1\nLine 2");
  });

  it("continues across more than two physical lines, then resumes normal tokenizing", () => {
    const toks = tokenize('tt = "Line 1\n  Line 2\nLine 3"\nplot(close, title=tt)');
    const str = toks.find((t) => t.type === "STRING");
    expect(str?.value).toBe("Line 1\n  Line 2\nLine 3");

    // 닫는 따옴표 이후 문(plot(...))은 정상 토큰 스트림으로 이어져야 한다.
    const toks2 = tokenize('tt = "a\nb"\nplot(close)');
    expect(toks2.map((t) => t.type)).toEqual([
      "IDENTIFIER", "ASSIGN", "STRING", "NEWLINE",
      "IDENTIFIER", "LPAREN", "IDENTIFIER", "RPAREN", "NEWLINE",
      "EOF",
    ]);
  });

  it("reports the STRING token's line as the line where it opened", () => {
    const toks = tokenize('x = 1\ntt = "Line 1\nLine 2"');
    const str = toks.find((t) => t.type === "STRING")!;
    expect(str.line).toBe(2);
  });

  it("reports NEWLINE after the closing quote's physical line, not the opening line", () => {
    const toks = tokenize('tt = "Line 1\nLine 2"');
    const nl = toks.find((t) => t.type === "NEWLINE")!;
    expect(nl.line).toBe(2);
  });

  it("keeps matching a single-quoted multi-line string to a single quote (not double)", () => {
    const toks = tokenize("tt = 'Line 1\nLine 2'");
    const str = toks.find((t) => t.type === "STRING");
    expect(str?.value).toBe("Line 1\nLine 2");
  });

  it("does not treat a '//' inside a swallowed continuation line as a comment", () => {
    const toks = tokenize('tt = "Line 1\n// not a comment\nLine 3"\nplot(close)');
    const str = toks.find((t) => t.type === "STRING");
    expect(str?.value).toBe("Line 1\n// not a comment\nLine 3");
    expect(toks.some((t) => t.type === "IDENTIFIER" && t.value === "plot")).toBe(true);
  });

  it("still terminates cleanly (no hang) when a string never finds a closing quote before EOF", () => {
    const toks = tokenize('x = "abc\nplot(close)');
    expect(toks[toks.length - 1]!.type).toBe("EOF");
  });

  it("keeps single-line strings byte-identical to prior behavior (regression guard)", () => {
    const toks = tokenize('indicator("smoke", overlay=true)\nx = "abc" + "def"');
    const strs = toks.filter((t) => t.type === "STRING").map((t) => t.value);
    expect(strs).toEqual(["smoke", "abc", "def"]);
  });
});
