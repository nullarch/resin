// PineScript 파서: var 선언, :=/= 대입, 표현식 우선순위 전체(삼항/or/and/not/비교/사칙연산),
// 점 접근 호출(ta.sma 등), 식별자/숫자/문자열/na 리터럴, if/for/while/switch 제어문(statement),
// UDF 선언(name(params) => body)과 튜플 destructure([a,b] = expr) 파싱.

import type { Token, TokenType } from "./tokens";
import { tokenize } from "./lexer";
import type {
  Assignment,
  BinOp,
  BoolLiteral,
  BreakStmt,
  CallExpr,
  CallKwarg,
  ColorLiteral,
  ContinueStmt,
  EnumDecl,
  EnumMember,
  Expr,
  ExprStmt,
  FieldAssignment,
  ForInStmt,
  ForStmt,
  FuncDecl,
  FuncParam,
  Identifier,
  IfStmt,
  IndexAccess,
  MethodDecl,
  NaLiteral,
  NumberLiteral,
  Script,
  Stmt,
  StringLiteral,
  SwitchCase,
  SwitchStmt,
  TernaryOp,
  TupleDestructure,
  TupleExpr,
  TypeDecl,
  TypeField,
  UnaryOp,
  VarDecl,
  WhileStmt,
} from "./ast";

const COMPARISON_OPS: Readonly<Partial<Record<TokenType, BinOp["op"]>>> = {
  EQ: "==",
  NEQ: "!=",
  LT: "<",
  GT: ">",
  LTE: "<=",
  GTE: ">=",
};

// 복합 대입 연산자(`x += value` 등) → `x := x op value` 데슈가링 매핑(pine2py parser.py
// `_COMPOUND_OPS`와 동일 발상). 렉서는 이미 이 5개를 별도 토큰(PLUS_ASSIGN 등, tokens.ts)으로
// 방출하지만 종전 파서는 소비하는 곳이 없어(C195 parser 감사로 발견 — 렉서 테스트는 토큰화만
// 검증했을 뿐 파서 단계 배선이 없었음) `x += 1` 같은 흔한 누적 패턴이 전부 ParseError였다.
const COMPOUND_ASSIGN_OPS: Readonly<Partial<Record<TokenType, BinOp["op"]>>> = {
  PLUS_ASSIGN: "+",
  MINUS_ASSIGN: "-",
  STAR_ASSIGN: "*",
  SLASH_ASSIGN: "/",
  PERCENT_ASSIGN: "%",
};

// dot 뒤 attr 위치에서 IDENTIFIER 대신 허용하는 예약 키워드 토큰(pine2py parser.py
// `_KEYWORD_AS_ATTR` 그대로 이식, C134 — TV 빌트인 attr 이름이 우리 렉서의 예약어와 우연히
// 겹치는 사례, `enum`이 `input.enum(...)`에서 첫 충돌로 발견됨). DOT 직후라는 위치가 이미
// 무조건 attr 자리로 소비되므로(파서가 다른 문법으로 재해석할 여지가 없음) 어떤 예약 키워드가
// 와도 모호성이 없다 — pine2py가 이미 검증해둔 범위를 그대로 재사용, 새로 좁혀 설계하지 않음.
const KEYWORD_AS_ATTR: ReadonlySet<TokenType> = new Set<TokenType>([
  "ENUM",
  "TYPE",
  "METHOD",
  "IMPORT",
  "EXPORT",
  "STRATEGY",
  "INDICATOR",
  "LIBRARY",
  "VAR",
  "VARIP",
  "IF",
  "FOR",
  "WHILE",
  "SWITCH",
]);

// array.new<TYPE>(size, initial_value)의 TYPE 인자로 유효한 값 — analyzer/collections.ts
// ARRAY_REGISTRY의 new_float/new_int/new_bool/new_string/new_color 5종 suffix와 정확히 대응
// (C221, corpus 121건 실측). map.new<K,V>()와 달리 array는 값 타입별로 기본값(NaN/0/false/''/na)이
// 다른 별개 런타임 생성자라 이 타입 인자를 버릴 수 없다 — pine2py처럼 무타입 단일 생성자로
// 뭉개면 기본값이 갈린다(next_hint 참조).
const ARRAY_NEW_TYPES: ReadonlySet<string> = new Set(["float", "int", "bool", "string", "color"]);

// 괄호 없이 쓰는 ta.* 암묵 호출 9종(TV 문법, pine2py codegen.py TA_IMPLICIT_CALL과 정확히 동일 —
// wavealgo/ta.* 쪽 함수 시그니처가 전부 인자 없음/OHLCV는 context에서 암묵 주입). analyzer의
// TA_REGISTRY에 이미 argCount:0 dispatch:"ta"로 등록돼 있는 이름과 정확히 겹친다.
const TA_BARE_IMPLICIT_CALL_ATTRS: ReadonlySet<string> = new Set([
  "tr", "accdist", "wad", "wvad", "iii", "obv", "pvt", "nvi", "pvi",
]);

export class ParseError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(`${message} (L${line}:${col})`);
    this.line = line;
    this.col = col;
  }
}

export class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  static parse(source: string): Script {
    return new Parser(tokenize(source)).parseScript();
  }

  private peek(offset = 0): Token {
    const idx = Math.min(this.pos + offset, this.tokens.length - 1);
    return this.tokens[idx]!;
  }

  private advance(): Token {
    const t = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private match(type: TokenType): Token | null {
    if (this.check(type)) return this.advance();
    return null;
  }

  private expect(type: TokenType, context: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new ParseError(`expected ${type} ${context}, got ${t.type} (${t.value || ""})`, t.line, t.col);
    }
    return this.advance();
  }

  private skipNewlines(): void {
    while (this.check("NEWLINE")) this.advance();
  }

  // `//@...` 애노테이션(TV 공식 auto-doc 주석: @variable/@field/@param 등)은 렉서가 자신의
  // 줄을 NEWLINE 없이 통째로 소비해 토큰 스트림에 단독으로 끼어든다(lexer.ts tokenizeLine
  // L81-84) — parseScript()는 이미 이를 건너뛰지만, if/for/while/switch/type/enum 등 INDENT
  // 블록을 여는 모든 지점도 조건-NEWLINE과 실제 INDENT 사이(또는 블록 내부 문장 사이)에 애노테이션이
  // 끼면 동일하게 건너뛰어야 한다(C316이 발견한 parseBlock() 크래시의 근본 수정, DIVERGENCES 없음 —
  // 애노테이션은 AST에 실을 정보가 없는 순수 주석).
  private skipAnnotations(): void {
    while (this.check("ANNOTATION")) this.advance();
  }

  parseScript(): Script {
    const body: Stmt[] = [];
    this.skipNewlines();
    while (!this.check("EOF")) {
      if (this.check("ANNOTATION")) {
        this.advance();
        this.skipNewlines();
        continue;
      }
      // import 선언(pine2py parser.py _parse_import 그대로 이식, C274) — `import user/lib/1 as
      // alias`. pine2py도 이 노드를 파스만 하고 codegen에서 주석 한 줄로 버릴 뿐 실제 라이브러리
      // 소스를 로드/해석하는 기능이 전혀 없다(단일 소스 문자열만 다루는 아키텍처라 원천적으로 불가,
      // docs/pinescript/09-edge-cases.md도 "Phase 1 미지원"으로 명시) — corpus 실측 7건 전수가
      // import한 별칭을 본문에서 단 한 번도 참조하지 않는 죽은 선언이라(등록만 하고 아무도 안 쓰는
      // 패턴, gen_oracle.py 검증으로 재확인) ANNOTATION과 동일하게 완전히 스킵해도 실행 결과에
      // 영향이 없다 — AST 노드조차 만들지 않고 토큰만 소비(alias를 쓰는 실사용 코드가 나타나면 그때
      // "알 수 없는 식별자" 에러로 자연히 드러남, 침묵 오답 아님).
      if (this.check("IMPORT")) {
        this.skipImportStmt();
        this.skipNewlines();
        continue;
      }
      if (this.check("INDENT") || this.check("DEDENT")) {
        const t = this.peek();
        throw new ParseError("예상치 못한 들여쓰기 블록", t.line, t.col);
      }
      body.push(...this.parseStatementWithCommas());
      this.skipNewlines();
    }
    return { kind: "Script", line: 1, col: 1, body };
  }

  // import user/library/version [as alias] — 경로/별칭 전부 버린다(위 parseScript 주석 참조).
  // pine2py parser.py _parse_import과 동일한 토큰 소비 구조(SLASH 구분 경로 + "as"는 예약어가
  // 아니라 IDENTIFIER 값으로 판별 — pine2js 렉서도 "as"를 키워드로 토큰화하지 않음).
  private skipImportStmt(): void {
    this.advance(); // IMPORT
    this.expect("IDENTIFIER", "in import path");
    this.skipHyphenChain();
    while (this.check("SLASH")) {
      this.advance();
      if (this.check("IDENTIFIER") || this.check("NUMBER")) {
        this.advance();
        this.skipHyphenChain();
      }
    }
    if (this.check("IDENTIFIER") && this.peek().value === "as") {
      this.advance();
      this.expect("IDENTIFIER", "in import alias");
    }
  }

  // 하이픈 포함 사용자명/라이브러리명(예: `RVD-Projects`) 대응(C460, wild 실측) — 렉서는
  // `-`를 MINUS로 별도 토큰화하므로 그대로 두면 경로 세그먼트가 여기서 끊겨 나머지
  // (`-Projects/Types/3`)가 다음 문장으로 새어나가 "알 수 없는 식별자"를 낸다. 경로 값 자체는
  // 어차피 전부 버려지므로(위 skipImportStmt 주석 참조) 토큰 소비만 정확히 맞추면 된다.
  private skipHyphenChain(): void {
    while (this.check("MINUS") && this.peek(1).type === "IDENTIFIER") {
      this.advance(); // MINUS
      this.advance(); // IDENTIFIER
    }
  }

  // 쉼표로 구분된 다중 문장: `a = 1, b = 2` (pine2py parser.py _parse_statement_with_commas
  // 동일 알고리즘, C304). 문장 종류 무관(var decl/대입/재대입/bare 콜 등 전부) 균일 허용 --
  // pine2py도 이 조합을 검증 없이 그대로 통과시킨다(오라클과 정합).
  // C319: pine2py는 이 루프를 `현재 토큰의 물리 줄 === 시작 줄`로 한정해 트레일링 쉼표가 다음
  // 물리 줄로 이어지는 경우(COMMA가 lexer.ts CONTINUATION_OPS라 NEWLINE 자체가 나오지 않음)를
  // 지원 못한다 -- wild 실제 GitHub 스크립트(`[tid_001,out_001]=feed(...), [tid_002,...]=feed(...),`
  // 를 10줄에 걸쳐 40개 문장 나열)로 python 직접 실행 재현 결과 pine2py 자신도 동일
  // "Unexpected token: COMMA"로 크래시함을 확인("pine2py 버그를 따르지 않는다" 원칙, DIVERGENCES
  // #125) -- 물리 줄 제한을 완전히 제거해도 안전한 이유는 lexer가 진짜 NEWLINE 경계에서만 COMMA
  // 다음에 새 문장을 두므로(중첩 호출 인자 목록의 쉼표는 그 호출의 parseExpr가 이미 다 소비)
  // "완료된 문장 직후 COMMA"는 물리 줄과 무관하게 항상 문장 구분자다.
  private parseStatementWithCommas(): Stmt[] {
    const results: Stmt[] = [this.parseStatement()];
    while (this.check("COMMA")) {
      this.advance(); // comma
      results.push(this.parseStatement());
    }
    return results;
  }

  private parseStatement(): Stmt {
    // export 접두어(pine2py parser.py _parse_export 그대로 이식, C274) — library() 스크립트가
    // 외부 공개용으로 표시하는 문법적 장식일 뿐 pine2py도 이 플래그를 어디서도 읽지 않는다(exported
    // 필드를 설정만 하고 소비하는 codegen 분기가 없음, python 소스 grep으로 확인) — pine2js는
    // 애초에 단일 파일만 다뤄 "외부 공개"라는 개념 자체가 없으므로 토큰만 소비하고 다음 선언을
    // 그대로 재귀 파싱하면 충분(FuncDecl/TypeDecl/EnumDecl/MethodDecl/VarDecl 전부 자동 커버,
    // pine2py의 export-종류별 개별 분기보다 이 재귀 fallback이 더 단순하고 동등).
    if (this.check("EXPORT")) {
      this.advance();
      return this.parseStatement();
    }
    if (this.check("VAR") || this.check("VARIP")) {
      return this.parseVarDecl();
    }
    // TYPE 키워드는 `type Name`(UDT 선언, 다음 토큰이 IDENTIFIER) 형태일 때만 그 의미로
    // 소비한다 -- wild corpus에 "type"을 bare 변수명으로 쓰는 실전 관용구(`type =
    // input.string(...)`, 옵션 select류)가 42건 있어(C480), 1토큰 lookahead 없이 무조건
    // parseTypeDecl로 커밋하면 IDENTIFIER 기대 위치에서 ASSIGN을 만나 항상 ParseError였다.
    // parsePrimary(L1330 부근)가 이미 TYPE을 표현식 위치에서 bare Identifier로 인정하므로,
    // 여기서 fall-through만 하면 parseAssignmentOrExpr가 나머지를 그대로 처리한다.
    if (this.check("TYPE") && this.peek(1).type === "IDENTIFIER") return this.parseTypeDecl();
    if (this.check("ENUM")) return this.parseEnumDecl();
    // METHOD도 TYPE(위 C480)과 동일한 함정: wild corpus에 "method"를 bare 변수명으로 쓰는 관용구가
    // 있다(`method = input.string('Atr', ...)`, C691, LuxAlgo 계열 지표). 1토큰 lookahead 없이
    // 무조건 parseMethodDecl로 커밋하면 이름 자리(IDENTIFIER 기대)에서 ASSIGN을 만나 항상
    // "expected IDENTIFIER in method declaration, got ASSIGN"였다. parsePrimary(위 IDENTIFIER
    // 화이트리스트, C691)가 이미 METHOD를 표현식 위치에서 bare Identifier로 인정하므로, 여기서
    // fall-through만 하면 parseAssignmentOrExpr가 나머지를 그대로 처리한다.
    // C768: method 이름 자리도 예약어일 수 있다(`method type(string str) => str`, wild 3건) — 이름은
    // parseMethodDecl이 직접 advance하므로(재파싱 없음) KEYWORD_AS_ATTR 전체를 var 선언(C766)과
    // 동일 근거로 그대로 재사용해도 안전. peek(1)이 LPAREN이면(이름 자리 자체가 없음) 아래 별도
    // 분기(METHOD 자신이 함수 이름)로 넘어간다 — 두 분기는 peek(1) 종류로 서로소.
    if (this.check("METHOD") && (this.peek(1).type === "IDENTIFIER" || KEYWORD_AS_ATTR.has(this.peek(1).type))) {
      return this.parseMethodDecl();
    }
    // C768: `method(int idx) => idx + 1`(wild 2건) — "method"가 이름 자리 없이 그 자체로 UDF 이름.
    // method decl은 항상 명시적 이름이 필요해(TV 문법) 이름 없이 곧장 '('가 오면 이 형태로 확정된다
    // (위 분기와 peek(1) 종류로 상호배타). isFuncDecl()과 동일한 괄호매칭+FAT_ARROW 확인만
    // 오프셋만 바꿔 재사용.
    if (this.check("METHOD") && this.peek(1).type === "LPAREN" && this.isBalancedParenThenFatArrowFrom(1)) {
      const nameTok = this.advance(); // METHOD를 함수 이름으로 소비
      const { params, body } = this.parseParamsAndBody();
      return { kind: "FuncDecl", name: nameTok.value, params, body, line: nameTok.line, col: nameTok.col };
    }
    if (this.check("IF")) return this.parseIf();
    if (this.check("FOR")) return this.parseFor();
    if (this.check("WHILE")) return this.parseWhile();
    if (this.check("SWITCH")) return this.parseSwitch();
    if (this.check("BREAK")) {
      const kw = this.advance();
      return { kind: "BreakStmt", line: kw.line, col: kw.col } satisfies BreakStmt;
    }
    if (this.check("CONTINUE")) {
      const kw = this.advance();
      return { kind: "ContinueStmt", line: kw.line, col: kw.col } satisfies ContinueStmt;
    }
    if (this.check("IDENTIFIER") && this.isFuncDecl()) {
      return this.parseFuncDecl();
    }
    if (this.check("LBRACKET") && this.isTupleDestructure()) {
      return this.parseTupleDestructure();
    }
    return this.parseAssignmentOrExpr();
  }

  // SERIES/SIMPLE은 한정자 키워드지만, 파라미터 "이름"으로 bare 채택되는 자리가 이미 있듯(C558),
  // "타입 바로 다음은 반드시 이름"인 고정 슬롯(var/local 선언 신규, UDT 필드, 함수 파라미터)에서도
  // wild 스크립트가 실제 변수/필드 이름으로 흔히 쓴다(`float simple = ...`류, C660 실측 —
  // corpus_scan v2 "알 수 없는 식별자" 클러스터 실갭). 이 슬롯들은 전부 타입 뒤 다음 토큰이
  // 곧 이름이라는 문맥이 확정돼 있어 SERIES/SIMPLE이 와도 모호성이 없다. CONST는 제외 -- parsePrimary
  // (표현식 term 위치, L1538 부근)를 포함해 이 토큰을 bare 값으로 인정하는 곳이 어디에도 없어(파라미터
  // 자리의 최종 이름 소비도 CONST는 빠져 있음) 이름으로만 받아주면 본문에서 다시 참조할 방법이 없는
  // 반쪽짜리 지원이 되고, wild corpus에도 근거가 없다.
  private isBareNameQualifier(type: TokenType): boolean {
    return type === "SERIES" || type === "SIMPLE";
  }

  // parsePrimary(표현식 term 위치, L1684 이하)가 이미 bare Identifier로 인정하는 예약어
  // 화이트리스트 중 SERIES/SIMPLE을 제외한 나머지(INDICATOR/STRATEGY/LIBRARY/TYPE/METHOD) --
  // C765 next_hint, wild `string strategy = input.string(...)` 실측: `TYPE name = value`(var 없는
  // 신규 로컬) lookahead가 name 토큰을 직접 advance하지 않고 parseExpr()에 위임해 재파싱하므로,
  // 이 자리에 쓰는 화이트리스트는 parsePrimary가 실제로 bare Identifier로 받아주는 토큰 집합과
  // 반드시 일치해야 한다(parseVarDecl/parseFuncParam처럼 이름 토큰을 직접 advance하는 자리는
  // KEYWORD_AS_ATTR 전체를 그대로 써도 안전하지만, 여기서 그 전체 집합을 쓰면 VAR/IF/FOR/WHILE/
  // SWITCH/ENUM/IMPORT/EXPORT가 섞여 parseExpr()이 제어문-식 또는 ParseError로 엉뚱하게 갈린다).
  private isPrimaryBareNameToken(type: TokenType): boolean {
    return type === "INDICATOR" || type === "STRATEGY" || type === "LIBRARY" || type === "TYPE" || type === "METHOD";
  }

  // lookahead: `name(...) =>` 패턴인지 확인 (괄호 짝을 맞춰 건너뛴 뒤 FAT_ARROW 존재 확인).
  private isFuncDecl(): boolean {
    const save = this.pos;
    try {
      if (!this.check("IDENTIFIER")) return false;
      this.advance();
      if (!this.check("LPAREN")) return false;
      let depth = 1;
      this.advance();
      while (depth > 0 && !this.check("EOF")) {
        if (this.check("LPAREN")) depth += 1;
        else if (this.check("RPAREN")) depth -= 1;
        this.advance();
      }
      return this.check("FAT_ARROW");
    } finally {
      this.pos = save;
    }
  }

  // isFuncDecl()의 괄호매칭+FAT_ARROW 확인 부분만 시작 오프셋을 매개변수화해 재사용(C768,
  // `method(...)` — 이름 토큰이 이미 확정된 자리(offset만큼 건너뛰면 바로 LPAREN)에서 씀. pos를
  // 건드리지 않고 peek(offset)만으로 스캔해 save/restore가 필요 없다.
  private isBalancedParenThenFatArrowFrom(offset: number): boolean {
    if (this.peek(offset).type !== "LPAREN") return false;
    let depth = 1;
    let i = offset + 1;
    while (depth > 0 && this.peek(i).type !== "EOF") {
      if (this.peek(i).type === "LPAREN") depth += 1;
      else if (this.peek(i).type === "RPAREN") depth -= 1;
      i += 1;
    }
    return this.peek(i).type === "FAT_ARROW";
  }

  // lookahead: `[...] =` 패턴인지 확인 (']' 바로 뒤에 '=' 존재 확인, 대괄호 짝 유지).
  private isTupleDestructure(): boolean {
    let depth = 0;
    let i = this.pos;
    while (i < this.tokens.length) {
      const t = this.tokens[i]!;
      if (t.type === "LBRACKET") {
        depth += 1;
      } else if (t.type === "RBRACKET") {
        depth -= 1;
        if (depth === 0) {
          const next = this.tokens[i + 1];
          return next !== undefined && next.type === "ASSIGN";
        }
      } else if (t.type === "EOF") {
        return false;
      }
      i += 1;
    }
    return false;
  }

  // lookahead: 현재 위치가 '<'일 때, `< type_args... >` 뒤에 즉시 '('가 오는지 확인(pos는 복원).
  // 중첩 제네릭(예: matrix<array<float>>)을 대비해 depth로 짝을 맞춘다 — map.*는 중첩이 없지만
  // 향후 matrix.*가 재사용할 수 있어 방어적으로 둔다. NEWLINE/EOF를 만나면 실패(비교 연산자로 판단).
  private isGenericCallLookahead(): boolean {
    const save = this.pos;
    try {
      if (!this.check("LT")) return false;
      this.advance();
      let depth = 1;
      while (depth > 0) {
        const t = this.peek();
        if (t.type === "EOF" || t.type === "NEWLINE") return false;
        if (t.type === "LT") depth += 1;
        else if (t.type === "GT") depth -= 1;
        this.advance();
      }
      return this.check("LPAREN");
    } finally {
      this.pos = save;
    }
  }

  // isGenericCallLookahead()가 true를 반환한 직후에만 호출 — '<' 부터 짝이 맞는 '>' 까지 그대로
  // 소비해서 버린다(타입 인자는 codegen이 쓰지 않음).
  private skipGenericArgs(): void {
    this.advance(); // '<'
    let depth = 1;
    while (depth > 0) {
      const t = this.advance();
      if (t.type === "LT") depth += 1;
      else if (t.type === "GT") depth -= 1;
    }
  }

  // array.new<TYPE>(...) 전용 lookahead — isGenericCallLookahead()가 이미 '<...>' 뒤 '('을
  // 확인한 직후에만 호출된다. 정확히 `'<' IDENTIFIER(known 5종) '>'` 하나뿐인 좁은 패턴만
  // true(라벨/UDT/`chart.point`처럼 새 런타임 생성자가 필요한 타입은 false — 기존 skipGenericArgs
  // fallback으로 그대로 떨어져 이전과 동일한 "지원하지 않는 호출" 실패 경로를 유지한다, C221).
  private isArrayNewPrimitiveTypeArg(): boolean {
    return this.peek(1).type === "IDENTIFIER" && ARRAY_NEW_TYPES.has(this.peek(1).value) && this.peek(2).type === "GT";
  }

  // isArrayNewPrimitiveTypeArg()가 true를 반환한 직후에만 호출 — '<' IDENTIFIER '>'를 그대로 소비.
  private consumeArrayNewTypeArg(): string {
    this.advance(); // '<'
    const typeTok = this.advance(); // IDENTIFIER
    this.advance(); // '>'
    return typeTok.value;
  }

  // array.new<TYPE>(...)의 TYPE이 5종 원시 타입이 아닌 그 밖의 모든 타입 표현식(사용자 UDT 타입명,
  // label/chart.point 같은 built-in 특수 타입, `array<float>`/`map<string,float>` 같은 중첩 제네릭
  // 컨테이너 타입 등)일 때의 lookahead(C230/C355가 단일·점 하나 IDENTIFIER만 인정하던 것을 C426이
  // 확장 — wild corpus 실측: `array.new<array<float>>()` 2건이 이 폭 밖으로 빠져 미인식 "지원하지
  // 않는 호출"로 떨어지고 있었음). isArrayNewPrimitiveTypeArg()가 false를 반환한 뒤에만 시도되며,
  // TYPE이 IDENTIFIER로 시작하기만 하면(Pine 타입명은 전부 IDENTIFIER 토큰 — array/map/matrix도
  // 키워드가 아니라 평범한 식별자) 그 뒤 내용(점 체이닝/중첩 `<...>`)의 정확한 형태와 무관하게
  // 인정한다. pine2py는 이 모든 형태를 정확히 같은 무타입 단일 생성자로 라우팅하므로(_strip_generic이
  // '<' 이후 T 전체를 통째로 버림, codegen.py L82) T의 정확한 이름/구조는 애초에 codegen에 무의미
  // — 첫 세그먼트만 소비해 보존하고 나머지는 버린다.
  private isArrayNewGenericTypeArg(): boolean {
    return this.peek(1).type === "IDENTIFIER";
  }

  // isArrayNewGenericTypeArg()가 true를 반환한 직후에만 호출 — '<' 부터 짝이 맞는 '>' 까지(중첩
  // `<...>` 포함, skipGenericArgs와 동일한 depth 카운팅) 전부 소비한다. 라우팅 자체는 attr='new_generic'
  // 고정 하나뿐이라 예전엔 완전히 버렸으나(C230), C355부터는 맨 앞 IDENTIFIER(중첩 제네릭형은 그 첫
  // 세그먼트만 -- "array<float>"의 "array"는 어차피 UDT로 등록될 수 없어 호출부의 prog.udtTypes.has()
  // 체크가 자연히 걸러낸다)를 반환해 array.new<Gap>()류의 사용자 UDT 타입명을 보존한다 -- 호출부가
  // DotAccess.genericElemType에 저장. C490: "chart.point"류 점 접근 타입은 첫 세그먼트("chart")만
  // 남기면 CHART_POINT_FIELD_TYPE("chart.point")과 영영 일치하지 않아 array.new<chart.point>()의
  // typeHint 생략 케이스(LIMITATIONS C488)가 해소 불가 -- parseFieldTypeHint(L844)와 동일한
  // "DOT IDENTIFIER" 체인 lookahead를 앞당겨 적용해 dotted 세그먼트 전체를 합성한다(중첩 제네릭
  // `<...>`는 DOT로 시작하지 않으므로 이 루프에 안 걸려 기존 동작 무변화).
  private consumeArrayNewGenericTypeArg(): string {
    let typeName = this.peek(1).value; // 맨 앞 IDENTIFIER(아직 미소비 — depth 스캔 전에 값만 캡처)
    let ahead = 2;
    while (this.peek(ahead).type === "DOT" && this.peek(ahead + 1).type === "IDENTIFIER") {
      typeName += `.${this.peek(ahead + 1).value}`;
      ahead += 2;
    }
    this.advance(); // '<'
    let depth = 1;
    while (depth > 0) {
      const t = this.advance();
      if (t.type === "LT") depth += 1;
      else if (t.type === "GT") depth -= 1;
    }
    return typeName;
  }

  // map.new<K, V>()의 V(값 타입) 캡처 전용(C684) — isGenericCallLookahead()가 true를 반환한 직후에만
  // 호출된다. depth 1의 첫 COMMA 바로 뒤 IDENTIFIER(+ DOT 체이닝, consumeArrayNewGenericTypeArg의
  // C490 dotted 합성과 동일 — `map<string, chart.point>` 대비)를 V의 이름으로 합성해 반환하고,
  // '<'부터 짝이 맞는 '>'까지는 skipGenericArgs로 전부 소비한다. COMMA 뒤가 IDENTIFIER가 아니거나
  // COMMA 자체가 없으면 null(캡처 없이 소비만). 중첩 제네릭 값 타입(`map<string, array<float>>`)은
  // 첫 세그먼트("array")만 잡히는데, 그 이름은 UDT로 등록될 수 없어 호출부의 prog.udtTypes.has()/
  // DRAWING_ALL_NAMESPACES.has()가 자연히 걸러낸다(consumeArrayNewGenericTypeArg와 동일 근거).
  private consumeMapNewGenericValueTypeArg(): string | null {
    let valueType: string | null = null;
    let ahead = 1; // 현재 토큰이 '<' — peek(1)부터 스캔
    let depth = 1;
    while (depth > 0) {
      const t = this.peek(ahead);
      if (t.type === "EOF" || t.type === "NEWLINE") break; // isGenericCallLookahead가 이미 걸렀지만 방어
      if (t.type === "LT") depth += 1;
      else if (t.type === "GT") depth -= 1;
      else if (t.type === "COMMA" && depth === 1 && valueType === null && this.peek(ahead + 1).type === "IDENTIFIER") {
        valueType = this.peek(ahead + 1).value;
        let dotAhead = ahead + 2;
        while (this.peek(dotAhead).type === "DOT" && this.peek(dotAhead + 1).type === "IDENTIFIER") {
          valueType += `.${this.peek(dotAhead + 1).value}`;
          dotAhead += 2;
        }
      }
      ahead += 1;
    }
    this.skipGenericArgs();
    return valueType;
  }

  // lookahead: `IDENTIFIER '<' ... '>' IDENTIFIER '='` 패턴인지 확인 (제네릭 타입 var/신규-로컬
  // 선언, 예: `array<float> x = ...`, `map<string, int> m = ...`). pine2py parser.py
  // _is_generic_typed_var_decl(L1113-1139) literal port -- isGenericCallLookahead(콜사이트
  // 제네릭, '<...>' 뒤에 '(' 확인)와 depth 카운팅 짝 규칙은 같지만 종단 조건이 다르다(뒤에 오는
  // 게 IDENTIFIER '=' 인지).
  private isGenericTypedVarDecl(): boolean {
    if (!this.check("IDENTIFIER") || this.peek(1).type !== "LT") return false;
    const save = this.pos;
    try {
      this.advance(); // base type
      this.advance(); // '<'
      let depth = 1;
      while (depth > 0) {
        const t = this.peek();
        if (t.type === "EOF" || t.type === "NEWLINE") return false;
        if (t.type === "LT") depth += 1;
        else if (t.type === "GT") depth -= 1;
        this.advance();
      }
      return this.check("IDENTIFIER") && this.peek(1).type === "ASSIGN";
    } finally {
      this.pos = save;
    }
  }

  private parseFuncDecl(): FuncDecl {
    const nameTok = this.expect("IDENTIFIER", "in function declaration");
    const { params, body } = this.parseParamsAndBody();
    return { kind: "FuncDecl", name: nameTok.value, params, body, line: nameTok.line, col: nameTok.col };
  }

  // method name(params) => body — FuncDecl과 동일한 파라미터/본문 문법이라 parseParamsAndBody를
  // 그대로 공유한다(첫 파라미터의 typeHint가 이 method의 소속 UDT를 결정하는 것은 analyzer 몫 —
  // parseFuncParam이 이미 typeHint를 일반적으로 파싱해두므로 파서 쪽 특수 처리는 불필요).
  private parseMethodDecl(): MethodDecl {
    const kw = this.advance(); // METHOD
    // C768: 이름 자리도 예약어일 수 있다(`method type(...) => ...`) — 여기서 토큰을 직접
    // advance해 문자열로만 쓰므로(재파싱 없음) parseVarDecl(C766)과 동일 근거로 KEYWORD_AS_ATTR
    // 전체를 그대로 재사용해도 안전.
    const nameTok = KEYWORD_AS_ATTR.has(this.peek().type) ? this.advance() : this.expect("IDENTIFIER", "in method declaration");
    const { params, body } = this.parseParamsAndBody();
    return { kind: "MethodDecl", name: nameTok.value, params, body, line: kw.line, col: kw.col };
  }

  // (params) => body — FuncDecl/MethodDecl 공용.
  private parseParamsAndBody(): { params: FuncParam[]; body: Stmt[] } {
    this.expect("LPAREN", "in function declaration");
    const params: FuncParam[] = [];
    while (!this.check("RPAREN")) {
      params.push(this.parseFuncParam());
      if (this.check("COMMA")) this.advance();
    }
    this.expect("RPAREN", "to close function parameters");
    this.expect("FAT_ARROW", "in function declaration (expected '=>')");
    this.skipNewlines();
    const body = this.parseBlockOrExpr();
    return { params, body };
  }

  private parseFuncParam(): FuncParam {
    const start = this.peek();
    let typeHint: string | null = null;

    // C558: "series"/"simple"는 한정자 키워드지만 뒤에 아무 타입도 안 이어지면(콤마/닫는 괄호/
    // 기본값 '='가 바로 옴) TV는 그 토큰 자체를 파라미터 "이름"으로 받아들인다(wild
    // `pctrank(series, period) =>`/`plotCondition(series, condition, ...) =>` 등 — pine2py 파서도
    // series/simple을 FuncParam 위치에서 값 문자열로만 체크해 동일하게 bare 이름을 허용함,
    // MEMORY.md C4). 무조건 한정자로 소비하던 기존 로직은 이 폼에서 이어지는 이름 토큰을 통째로
    // 삼켜 "expected IDENTIFIER ... got COMMA"로 하드 에러를 냈다 — 이 lookahead 가드로 그 경우만
    // 한정자 소비를 건너뛰고 아래 이름 파싱(L545)에 넘긴다.
    // C596: "const"는 parseVarDecl(L924)/parseAssignmentOrExpr(L1023/1034)엔 이미 SERIES/SIMPLE과
    // 나란히 체크돼 있었는데(C558) 이 함수만 CONST 토큰을 빠뜨려 `f(const int x) => ...`가
    // "expected IDENTIFIER ... got CONST"로 거부됐다(wild clusterSize=6, ROADMAP). analyzer의
    // extractQualifierFromHint는 이미 "const" 첫 토큰을 Qualifier로 인식하므로(const ⊂ simple ⊂
    // series, 가장 낮은 rank라 병합 시 항상 상대측에 흡수돼 새 하드 에러를 만들 수 없음) 파서
    // 한정자 세트에 CONST만 추가하면 된다 — series/simple과 완전히 대칭.
    const qualifierIsBareName =
      (start.type === "SERIES" || start.type === "SIMPLE" || start.type === "CONST") &&
      (this.peek(1).type === "COMMA" || this.peek(1).type === "RPAREN" || this.peek(1).type === "ASSIGN");
    if ((start.type === "SERIES" || start.type === "SIMPLE" || start.type === "CONST") && !qualifierIsBareName) {
      typeHint = start.value;
      this.advance();
      if (this.check("LT")) {
        // v6 파라미터화 타입 wrapper 문법: `series<float>` === `series float` (C315, wild 2건,
        // export/library UDF 시그니처). qualifier 바로 뒤 '<'는 항상 단일 타입 인자 하나를
        // 감싸는 wrapper이므로 lookahead 없이 무조건 이 형태로 확정.
        this.advance(); // '<'
        typeHint += ` ${this.parseFieldTypeHint()}`;
        this.expect("GT", "in qualified type parameter (expected '>')");
      } else if (this.check("IDENTIFIER") && this.peek(1).type === "LT") {
        // 한정자+제네릭 조합: `series array<float> arr` (C315, wild 1건) -- 아래 bare-제네릭
        // 분기와 동일한 parseFieldTypeHint 재사용, "series"/"simple" 뒤에 이어붙인다.
        typeHint += ` ${this.parseFieldTypeHint()}`;
      } else if (this.check("IDENTIFIER") && this.peek(1).type === "DOT") {
        // C486: 한정자+점 접근 타입 조합(`series chart.point start`, wild) -- 위 한정자+제네릭
        // 분기(L489)와 동일하게 parseFieldTypeHint 재사용, dot-chain까지 그대로 이어붙인다.
        typeHint += ` ${this.parseFieldTypeHint()}`;
      } else if (this.check("IDENTIFIER") && this.peek(1).type === "LBRACKET" && this.peek(2).type === "RBRACKET") {
        // 한정자 + 대괄호-접미 배열 shorthand 조합: `series float[] arr`/`simple linefill[] arr`
        // (wild 7건 이상). 아래 무한정자 bracket-shorthand 분기(L525 이하)와 동일한 정규화를
        // qualifier 뒤에 이어붙인다 -- "qualifier array<base>" 합성 문자열(위 LT/DOT 분기와 동일
        // 포맷, extractQualifierFromHint/containerKindFromTypeHint 둘 다 첫 토큰만 qualifier로
        // 보고 나머지를 그대로 base 취급해 안전).
        const base = this.advance().value; // 타입명
        this.advance(); // '['
        this.advance(); // ']'
        typeHint += ` array<${base}>`;
      } else if (
        this.check("IDENTIFIER") &&
        (this.peek(1).type === "IDENTIFIER" ||
          KEYWORD_AS_ATTR.has(this.peek(1).type) ||
          this.isBareNameQualifier(this.peek(1).type))
      ) {
        typeHint += ` ${this.peek().value}`;
        this.advance();
      }
    } else if (
      start.type === "IDENTIFIER" &&
      this.peek(1).type === "LBRACKET" &&
      this.peek(2).type === "RBRACKET" &&
      this.peek(3).type === "IDENTIFIER"
    ) {
      // 대괄호-접미 배열 타입 shorthand: `calcStats(float[] arr, ...) =>` (`array<float>`의
      // 대체 표기). parseVarDecl(L688-696)과 동일한 lookahead + 정규화 -- pine2py parser.py
      // _is_array_type_shorthand/_consume_array_type_shorthand를 _parse_func_param에서도
      // 그대로 재사용함(literal port). typeHint는 다른 소비 지점(extractQualifierFromHint,
      // prog.udtTypes.has)과 매치되지 않아 var/varip 경로와 동일하게 순수 장식으로 안전.
      const base = this.advance().value; // 타입명
      this.advance(); // '['
      this.advance(); // ']'
      typeHint = `array<${base}>`;
    } else if (start.type === "IDENTIFIER" && this.peek(1).type === "LT") {
      // `array<float> arr`/`map<K,V> m`류 제네릭 타입힌트 파라미터 (C315, wild 166건) -- UDT
      // 필드 타입 자리(parseFieldTypeHint, L693 이하)와 동일 문법이라 그대로 재사용. 함수
      // 파라미터 자리도 "타입힌트 다음 파라미터명"이라는 고정 문법 슬롯이라 '<' 뒤에 무엇이
      // 오는지 확인하는 lookahead/백트래킹 없이 무조건 제네릭 인자 목록으로 파싱해도 안전.
      typeHint = this.parseFieldTypeHint();
    } else if (start.type === "IDENTIFIER" && this.peek(1).type === "DOT") {
      // C486: 점 접근 타입(`chart.point`) 매개변수 — UDT 필드(parseTypeField)의 동일한 dotted-type
      // 확장(wild `f(chart.point firstPoint) => ...`). parseFieldTypeHint가 dot-chain을 전부
      // 소비해 반환하므로 그 뒤 남는 토큰이 항상 파라미터명 IDENTIFIER(고정 문법 슬롯, 위 LT
      // 분기와 동일 근거) -- 재확인 불필요.
      typeHint = this.parseFieldTypeHint();
      // C754: 점 접근 타입 + 대괄호-접미 배열 shorthand 매개변수: `f(chart.point[] pts) => ...`
      // (parseTypeField L958/parseVarDecl L1114 자매 분기와 동일 정규화). 위 dot-chain 소비 직후
      // 남는 게 파라미터명이 아니라 "[]"이면 이 shorthand로 확정 -- 그 뒤가 다시 파라미터명 자리.
      if (this.check("LBRACKET") && this.peek(1).type === "RBRACKET") {
        this.advance(); // '['
        this.advance(); // ']'
        typeHint = `array<${typeHint}>`;
      }
    } else if (
      start.type === "IDENTIFIER" &&
      (this.peek(1).type === "IDENTIFIER" ||
        KEYWORD_AS_ATTR.has(this.peek(1).type) ||
        this.isBareNameQualifier(this.peek(1).type))
    ) {
      typeHint = start.value;
      this.advance();
    }

    // 파라미터 이름 위치는 dot-attr(L1055)/UDT 필드명(L663)과 동일하게 항상 "이름 자리"로
    // 확정된 문법 슬롯(C313 SERIES kwarg-이름 위치와 동형) -- TV의 흔한 파라미터 이름 "type"이
    // 우리 렉서의 TYPE 예약어와 충돌하는 실사용(wild `ma(source, length, type) =>` 등 192건,
    // C314)을 KEYWORD_AS_ATTR 재사용으로 해소. seriesOrSimpleIsBareName(위 C558)일 때는 SERIES/
    // SIMPLE 토큰 자체가 아직 미소비 상태로 여기 도달하므로 함께 허용 -- KEYWORD_AS_ATTR 전역
    // 집합에 넣지 않는 이유는 그 집합이 UDT 필드명/dot-attr 등 이 위치 밖 다른 문법 슬롯에도
    // 공유돼 wild 근거 없는 위치까지 조용히 넓히지 않기 위함(C283 큐레이션 원칙).
    const nameTok =
      KEYWORD_AS_ATTR.has(this.peek().type) || this.peek().type === "SERIES" || this.peek().type === "SIMPLE"
        ? this.advance()
        : this.expect("IDENTIFIER", "in function parameter");
    let defaultValue: Expr | null = null;
    if (this.check("ASSIGN")) {
      this.advance();
      defaultValue = this.parseExpr();
    }
    return {
      kind: "FuncParam",
      name: nameTok.value,
      typeHint,
      default: defaultValue,
      line: start.line,
      col: start.col,
    };
  }

  private parseTupleDestructure(): TupleDestructure {
    const start = this.expect("LBRACKET", "in tuple destructure");
    const names: string[] = [];
    while (!this.check("RBRACKET")) {
      // parsePrimary(L1667 부근)가 이미 bare Identifier term 위치에서 허용해둔 예약어 화이트리스트
      // (INDICATOR/STRATEGY/LIBRARY/TYPE/SERIES/SIMPLE/METHOD)를 튜플 디스트럭처 대상 자리에도
      // 대칭 확장(C726, wild `[_time, indicator, price, signal] = request.security(...)` 9건) --
      // 일반 '=' 대입 대상은 이미 이 화이트리스트로 bare 참조가 가능한데 튜플 디스트럭처만 IDENTIFIER
      // 토큰으로 좁게 막혀 있던 비대칭이었다. 이 위치는 '[' 직후 콤마-구분 이름 목록이라는 문법
      // 슬롯이 고정돼 있어(다른 문법으로 재해석될 여지 없음) 어떤 예약어가 와도 모호성이 없다.
      const t = this.peek();
      if (
        t.type === "IDENTIFIER" ||
        t.type === "INDICATOR" ||
        t.type === "STRATEGY" ||
        t.type === "LIBRARY" ||
        t.type === "TYPE" ||
        t.type === "SERIES" ||
        t.type === "SIMPLE" ||
        t.type === "METHOD"
      ) {
        names.push(this.advance().value);
      } else {
        names.push(this.expect("IDENTIFIER", "in tuple destructure target").value);
      }
      if (this.check("COMMA")) this.advance();
    }
    this.expect("RBRACKET", "to close tuple destructure");
    this.expect("ASSIGN", "in tuple destructure (expected '=')");
    const value = this.parseExpr();
    return { kind: "TupleDestructure", names, value, line: start.line, col: start.col };
  }

  // 들여쓰기 블록: INDENT 문장* DEDENT. if/for/while/switch 본문에서 공용.
  private parseBlock(): Stmt[] {
    const body: Stmt[] = [];
    this.skipAnnotations();
    if (this.match("INDENT")) {
      this.skipNewlines();
      while (!this.check("DEDENT") && !this.check("EOF")) {
        body.push(...this.parseStatementWithCommas());
        this.skipNewlines();
        this.skipAnnotations();
      }
      if (this.check("DEDENT")) this.advance();
    }
    return body;
  }

  // switch case 본문(및 UDF/method 한 줄 본문): 들여쓰기 블록 또는 같은 줄의 단일/쉼표-연쇄
  // 표현식(`1 => "one"` 또는 `1 => sideEffect(), "one"`, C319). pine2py `_parse_block_or_expr`는
  // 단일 표현식만 파싱(python 직접 실행으로 동일 "Unexpected token: COMMA" 크래시 재현 확인,
  // DIVERGENCES #125) -- wild 실제 스크립트가 이 자리에 여러 문장을 쉼표로 나열하는 실사용을
  // 확인해 parseStatementWithCommas와 동일한 "쉼표 = 문장 구분자" 개념을 여기도 이식한다.
  // inSwitchCase=true(switch case 전용)일 때만 각 쉼표 앞에서 lookahead로 "다음이 새 case
  // arm(`expr FAT_ARROW`)인가"를 확인해, 그렇다면 쉼표를 소비하지 않고 멈춘다 -- 같은 쉼표가
  // "이 case 본문 안 문장 구분자"와 "한 줄에 나열된 다음 case의 구분자"(예:
  // `0 => "IDLE", 1 => "PRE"`) 두 문법을 겸해 lookahead 없이는 구분 불가하다. UDF/method 한 줄
  // 본문(inSwitchCase 기본값 false)은 이 모호성이 없어 쉼표를 항상 문장 연쇄로만 소비한다.
  private parseBlockOrExpr(inSwitchCase = false): Stmt[] {
    this.skipAnnotations();
    if (this.check("INDENT")) return this.parseBlock();
    // parseExpr()이 아니라 parseAssignmentOrExpr()를 쓰는 이유: 체인 항목이 순수 표현식뿐 아니라
    // `counter := counter + 1`류 재대입 문장일 수도 있다(wild 실사용, C319). 단 parseStatement()
    // 전체를 쓰지는 않는다 -- parseStatement()의 최상단 TYPE/ENUM/METHOD/IF/FOR/WHILE/SWITCH
    // 디스패치는 "문장 시작 위치는 곧 그 키워드의 선언/제어문 의미"라고 가정하는데, 기존
    // "defaulted TYPE param"(C314) 테스트처럼 한 줄 본문이 그 이름의 파라미터 **값**을 bare
    // 참조하는 경우(`f(simple string type = "rsi") => type`)와 충돌해 회귀가 난다(parseStatement
    // 사용 시 실제로 재현 확인) -- parseAssignmentOrExpr는 parseExpr()로 먼저 내려가 이 TYPE
    // 디스패치 충돌 자체가 없으면서도 WALRUS 재대입/DotAccess FieldAssignment는 그대로 지원한다.
    const body: Stmt[] = [this.parseAssignmentOrExpr()];
    while (this.check("COMMA") && !(inSwitchCase && this.isNextCaseArmAfterComma())) {
      this.advance(); // comma
      body.push(this.parseAssignmentOrExpr());
    }
    this.skipNewlines();
    return body;
  }

  // lookahead: 현재 위치가 COMMA일 때, 그 다음이 `expr FAT_ARROW`(새 case arm 시작)인지 확인
  // (parseBlockOrExpr의 "본문 안 문장 구분자" vs "한 줄에 나열된 다음 case 구분자" 판별용, C319).
  private isNextCaseArmAfterComma(): boolean {
    const save = this.pos;
    try {
      this.advance(); // comma
      if (this.check("FAT_ARROW")) return true; // bare default arm (값 없는 `=>`)
      this.parseExpr();
      return this.check("FAT_ARROW");
    } catch {
      return false;
    } finally {
      this.pos = save;
    }
  }

  private parseIf(): IfStmt {
    const kw = this.advance(); // IF
    const condition = this.parseExpr();
    this.skipNewlines();
    const thenBody = this.parseBlock();

    const elifClauses: { condition: Expr; body: Stmt[] }[] = [];
    let elseBody: Stmt[] | null = null;

    while (this.check("ELSE")) {
      this.advance();
      if (this.match("IF")) {
        const elifCond = this.parseExpr();
        this.skipNewlines();
        const elifBody = this.parseBlock();
        elifClauses.push({ condition: elifCond, body: elifBody });
      } else {
        this.skipNewlines();
        elseBody = this.parseBlock();
        break;
      }
    }

    return { kind: "IfStmt", condition, thenBody, elifClauses, elseBody, line: kw.line, col: kw.col };
  }

  // for i = start to end [by step] / for x in arr / for [idx, val] in arr 셋 다 여기서 분기한다
  // (pine2py parser.py _parse_for L392-441 literal port — LBRACKET 튜플 분기 먼저, 그 다음
  // bare IDENTIFIER 뒤 값이 'in'인지로 for-in/range-for를 가른다. 'in'은 별도 TokenType이 아니라
  // IDENTIFIER로 토큰화되므로 값 비교로 판별한다 — MEMORY C4의 "pine2py가 token.value로 판별하는
  // 키워드는 pine2js도 값으로 확인" 원칙).
  private parseFor(): ForStmt | ForInStmt {
    const kw = this.advance(); // FOR

    // for [idx, val] in arr — 튜플 디스트럭처링 순회
    if (this.check("LBRACKET")) {
      this.advance();
      const names: string[] = [];
      while (!this.check("RBRACKET")) {
        names.push(this.expect("IDENTIFIER", "in for-in tuple target").value);
        if (this.check("COMMA")) this.advance();
      }
      this.expect("RBRACKET", "to close for-in tuple target");
      let indexName: string | null = null;
      let varName: string;
      if (names.length === 2) {
        indexName = names[0]!;
        varName = names[1]!;
      } else {
        varName = names[0] ?? "_";
      }
      if (this.check("IDENTIFIER") && this.peek().value === "in") this.advance();
      const iterable = this.parseExpr();
      this.skipNewlines();
      const body = this.parseBlock();
      return { kind: "ForInStmt", varName, indexName, iterable, body, line: kw.line, col: kw.col };
    }

    // for TYPE name = start to end — 타입 명시 for-루프 변수(`for int i = 1 to n`, wild 확인).
    // 일반 '=' 로컬 선언의 동일 3-토큰 lookahead(parseAssignmentOrExpr, IDENTIFIER IDENTIFIER
    // ASSIGN)와 대칭 — 루프 변수는 항상 숫자(GOAL.md: JS Number는 int/float 구분 없음)라 ForStmt에
    // typeHint 소비처가 없어 토큰만 소비하고 버린다. peek(1).value==="in"은 `for x in arr`와
    // 겹치지 않도록 제외.
    if (
      this.check("IDENTIFIER") &&
      this.peek(1).type === "IDENTIFIER" &&
      this.peek(1).value !== "in" &&
      this.peek(2).type === "ASSIGN"
    ) {
      this.advance(); // type token 소비, 버림
    }

    const nameTok = this.expect("IDENTIFIER", "in for-loop variable");

    // for x in arr
    if (this.check("IDENTIFIER") && this.peek().value === "in") {
      this.advance(); // consume 'in'
      const iterable = this.parseExpr();
      this.skipNewlines();
      const body = this.parseBlock();
      return { kind: "ForInStmt", varName: nameTok.value, indexName: null, iterable, body, line: kw.line, col: kw.col };
    }

    // for i = start to end [by step]
    this.expect("ASSIGN", "in for-loop (expected '=')");
    const start = this.parseExpr();
    this.expect("TO", "in for-loop (expected 'to')");
    const end = this.parseExpr();
    let step: Expr | null = null;
    if (this.match("BY")) {
      step = this.parseExpr();
    }
    this.skipNewlines();
    const body = this.parseBlock();
    return { kind: "ForStmt", varName: nameTok.value, start, end, step, body, line: kw.line, col: kw.col };
  }

  private parseWhile(): WhileStmt {
    const kw = this.advance(); // WHILE
    const condition = this.parseExpr();
    this.skipNewlines();
    const body = this.parseBlock();
    return { kind: "WhileStmt", condition, body, line: kw.line, col: kw.col };
  }

  private parseSwitch(): SwitchStmt {
    const kw = this.advance(); // SWITCH
    let subject: Expr | null = null;
    if (!this.check("NEWLINE")) {
      subject = this.parseExpr();
    }
    this.skipNewlines();

    const cases: SwitchCase[] = [];
    this.skipAnnotations();
    if (this.match("INDENT")) {
      while (!this.check("DEDENT") && !this.check("EOF")) {
        this.skipNewlines();
        this.skipAnnotations();
        if (this.check("DEDENT") || this.check("EOF")) break;

        let values: Expr[] | null = null;
        if (!this.check("FAT_ARROW")) {
          const first = this.parseExpr();
          values = [first];
          while (this.match("COMMA")) {
            values.push(this.parseExpr());
          }
        }
        this.expect("FAT_ARROW", "in switch case (expected '=>')");
        this.skipNewlines();
        const body = this.parseBlockOrExpr(true);
        cases.push({ values, body });
        // C319: `0 => "IDLE", 1 => "PRE"`처럼 한 줄에 여러 case arm을 나열하는 실사용 --
        // parseBlockOrExpr(true)가 이 쉼표 앞에서 이미 lookahead로 "다음이 새 case arm"임을
        // 확인해 소비하지 않고 멈춰뒀으므로, 여기서 구분자로 소비하고 다음 루프에서 정상적으로
        // 다음 case의 값 표현식을 파싱한다.
        if (this.check("COMMA")) this.advance();
      }
      if (this.check("DEDENT")) this.advance();
    }

    return { kind: "SwitchStmt", subject, cases, line: kw.line, col: kw.col };
  }

  // type Name\n    type_name field_name [= default]\n    ... — pine2py _parse_type_decl과 동일
  // 구조(들여쓰기 블록, DEDENT로 종료). 필드가 없는 `type Empty`(INDENT 자체가 없음)도 허용
  // (pine2py도 dataclass에 `pass` 하나로 빈 타입을 허용).
  private parseTypeDecl(): TypeDecl {
    const kw = this.advance(); // TYPE
    const nameTok = this.expect("IDENTIFIER", "in type declaration");
    this.skipNewlines();
    const fields: TypeField[] = [];
    this.skipAnnotations();
    if (this.match("INDENT")) {
      this.skipNewlines();
      while (!this.check("DEDENT") && !this.check("EOF")) {
        fields.push(this.parseTypeField());
        this.skipNewlines();
        this.skipAnnotations();
      }
      if (this.check("DEDENT")) this.advance();
    }
    return { kind: "TypeDecl", name: nameTok.value, fields, line: kw.line, col: kw.col };
  }

  // UDT 필드: `type_name field_name [= default]`. pine2py와 동일하게 type_hint는 항상 필수
  // (var/param과 달리 생략형이 없음 — parser.py _parse_type_field 대조) — 단 아래 두 예외는
  // wild tv_verdict accept 실측(TV가 실제로 컴파일)으로 C725에서 추가 확인됨.
  private parseTypeField(): TypeField {
    const start = this.peek();
    // varip 필드 한정자(TV v6 신규, C725, wild 7건): pine2js는 intrabar tick 시뮬레이션이
    // 없는 배치 리플레이 모델이라(GOAL.md) top-level var/varip도 이미 구분 없이 persistent
    // 슬롯 하나로 합쳐진다(VarDecl.persistent, C725 parseVarDecl 대조 확인) — UDT 필드도
    // 동일 원칙으로 한정자만 소비하고 버린다(객체 필드는 var 여부와 무관하게 이미 객체 수명
    // 동안 유지되므로 관측 가능한 차이 없음).
    if (this.check("VAR") || this.check("VARIP")) this.advance();
    // 타입힌트 생략 숏핸드: `field_name = default`(TV v5/v6, wild 4건, C725) — 다음 토큰이
    // ASSIGN이면 이 자리의 식별자는 타입이 아니라 필드명이다(타입 없는 필드는 항상 기본값을
    // 동반하므로 이 lookahead만으로 무모호 판별 가능).
    if (
      (this.check("IDENTIFIER") || KEYWORD_AS_ATTR.has(this.peek().type) || this.isBareNameQualifier(this.peek().type)) &&
      this.peek(1).type === "ASSIGN"
    ) {
      const nameTok = this.advance();
      this.advance(); // '='
      const defaultValue = this.parseExpr();
      return {
        kind: "TypeField",
        name: nameTok.value,
        typeHint: this.inferFieldTypeHintFromDefault(defaultValue),
        default: defaultValue,
        line: start.line,
        col: start.col,
      };
    }
    let typeHint: string;
    if (this.check("IDENTIFIER") && this.peek(1).type === "LBRACKET" && this.peek(2).type === "RBRACKET") {
      // 대괄호-접미 배열 타입 shorthand: `line[] ln_handle` (`array<line>`의 대체 표기).
      // parseVarDecl(L799)/parseFuncParam(C315)과 동일한 lookahead + 정규화 -- 이 위치(필드 타입
      // 자리)는 항상 "타입힌트 다음 필드명"이라는 고정 문법 슬롯이라(parseFieldTypeHint 주석과
      // 동일 근거) 뒤쪽 토큰이 필드명인지 확인하는 추가 lookahead가 불필요하다.
      const base = this.advance().value; // 타입명
      this.advance(); // '['
      this.advance(); // ']'
      typeHint = `array<${base}>`;
    } else {
      typeHint = this.parseFieldTypeHint();
      // C486: 점 접근 타입(`chart.point`) 뒤 대괄호-접미 배열 shorthand — 위 단일 IDENTIFIER
      // lookahead(peek(1)===LBRACKET)는 dotted 타입명에서 peek(1)이 DOT라 걸리지 않으므로
      // parseFieldTypeHint가 dotted base를 다 소비한 뒤 여기서 별도로 확인(wild
      // `chart.point[] pPC`). 단일 식별자 타입은 위 분기가 이미 처리해 이 경로에 안 온다.
      if (this.check("LBRACKET") && this.peek(1).type === "RBRACKET") {
        this.advance(); // '['
        this.advance(); // ']'
        typeHint = `array<${typeHint}>`;
      }
    }
    // 필드명 자리도 DotAccess attr(L991)과 동일하게 예약 키워드를 허용 (pine2py
    // parser.py _parse_type_field L659-661이 같은 _KEYWORD_AS_ATTR 셋을 필드명 위치에도
    // 재사용함을 소스 대조로 확인 — literal port, C263).
    const nameTok = KEYWORD_AS_ATTR.has(this.peek().type) || this.isBareNameQualifier(this.peek().type)
      ? this.advance()
      : this.expect("IDENTIFIER", "in type field (expected field name)");
    let defaultValue: Expr | null = null;
    if (this.check("ASSIGN")) {
      this.advance();
      defaultValue = this.parseExpr();
    }
    return {
      kind: "TypeField",
      name: nameTok.value,
      typeHint,
      default: defaultValue,
      line: start.line,
      col: start.col,
    };
  }

  // 타입힌트 생략 필드의 기본값 리터럴 종류로 typeHint 문자열을 합성(C725) — pine2py에
  // 대응 구현이 없어(_parse_type_field가 이 조합을 오히려 오파싱, 소스 대조 확인) 오라클
  // 근거 없는 hand-verified 규칙. int/float 구분은 raw 표기(소수점/지수 유무)로, 그 외
  // 리터럴이 아닌 기본값(식별자 참조 등)은 가장 흔한 스칼라인 float로 안전 폴백.
  private inferFieldTypeHintFromDefault(expr: Expr): string {
    if (expr.kind === "UnaryOp" && expr.op === "-") return this.inferFieldTypeHintFromDefault(expr.operand);
    if (expr.kind === "NumberLiteral") return /[.eE]/.test(expr.raw) ? "float" : "int";
    if (expr.kind === "BoolLiteral") return "bool";
    if (expr.kind === "StringLiteral") return "string";
    if (expr.kind === "ColorLiteral") return "color";
    return "float";
  }

  // 필드 타입 힌트: `IDENTIFIER` 또는 `IDENTIFIER '<' fieldTypeHint (',' fieldTypeHint)* '>'`
  // (예: `array<float>`, `map<string, float>`) — pine2py `_parse_type_expression`과 동일하게
  // 인자를 버리지 않고 합성 문자열("array<float>")로 조립해 반환한다. 이 위치는(필드 타입 자리)
  // 항상 "타입 힌트 다음 필드명 IDENTIFIER"라는 고정 문법 슬롯이라 표현식이 올 수 없으므로,
  // 콜사이트 제네릭(`map.new<K,V>()`, isGenericCallLookahead)과 달리 '<' 뒤에 무엇이 오는지
  // 미리 확인하는 lookahead/백트래킹이 불필요하다 — '<'를 보면 무조건 제네릭 인자 목록이다.
  private parseFieldTypeHint(): string {
    let base = this.expect("IDENTIFIER", "in type field (expected field type)").value;
    // C486: 점 접근 타입명(`chart.point`) — pine2py parser.py _parse_type_expression의 동일 while
    // 루프 literal port(제네릭 '<' 확인보다 먼저 — chart.point<...>류는 근거 없어 순서 무관하지만
    // pine2py 소스 순서 그대로 유지). pine2py 자신의 _parse_type_field 호출부는 이 루프에 도달하는
    // 경로가 없어(제네릭 '<' 없는 필드는 첫 토큰 1개만 소비하는 별도 분기) DOT를 못 삼키고 이후
    // 다음 필드 파싱에서 ParseError로 크래시하는 실제 버그를 python 직접 실행으로 확인(오라클
    // 구조적 불가, 33건 전량 pine2py도 파싱 불가) — 이 함수 자체(다른 호출부: var/func-param 제네릭
    // 분기)는 pine2py 원본과 동형이라 literal-port 대상, TV 자체는 chart.point가 문서화된 실존
    // 내장 타입이라 필드 위치 허용을 의심할 근거가 없어 hand-verified로 지원(DIVERGENCES 등재).
    while (this.check("DOT") && this.peek(1).type === "IDENTIFIER") {
      this.advance(); // '.'
      base += `.${this.advance().value}`;
    }
    if (!this.check("LT")) return base;
    this.advance(); // '<'
    const args: string[] = [this.parseFieldTypeHint()];
    while (this.check("COMMA")) {
      this.advance();
      args.push(this.parseFieldTypeHint());
    }
    this.expect("GT", "in generic type field (expected '>')");
    return `${base}<${args.join(", ")}>`;
  }

  // enum Name\n    member1\n    member2 = "title"\n    ... — parseTypeDecl과 동일한 INDENT 블록
  // 패턴, 멤버는 bare identifier 또는 `identifier = STRING`(title, ast.ts EnumMember 주석 참조).
  private parseEnumDecl(): EnumDecl {
    const kw = this.advance(); // ENUM
    const nameTok = this.expect("IDENTIFIER", "in enum declaration");
    this.skipNewlines();
    const members: EnumMember[] = [];
    this.skipAnnotations();
    if (this.match("INDENT")) {
      this.skipNewlines();
      while (!this.check("DEDENT") && !this.check("EOF")) {
        members.push(this.parseEnumMember());
        this.skipNewlines();
        this.skipAnnotations();
      }
      if (this.check("DEDENT")) this.advance();
    }
    return { kind: "EnumDecl", name: nameTok.value, members, line: kw.line, col: kw.col };
  }

  private parseEnumMember(): EnumMember {
    const nameTok = this.expect("IDENTIFIER", "in enum member");
    let title: string | null = null;
    if (this.match("ASSIGN")) {
      const titleTok = this.expect("STRING", "as enum member title (must be a string literal)");
      title = titleTok.value;
    }
    return { kind: "EnumMember", name: nameTok.value, title, line: nameTok.line, col: nameTok.col };
  }

  private parseVarDecl(): VarDecl {
    const kw = this.advance(); // VAR | VARIP
    let typeHint: string | null = null;
    // 대괄호-접미 배열 타입 shorthand: `var float[] arr = ...` (`array<float>`의 대체 표기).
    // pine2py parser.py _is_array_type_shorthand/_consume_array_type_shorthand(L1003-1017)
    // literal port -- `float[]`를 `array<float>`로 정규화해 `_parse_type_expression`(제네릭
    // `array<float>` 직접 표기) 결과와 동일한 타입힌트 문자열을 만듦. pine2py 자신은
    // codegen._gen_var_decl이 type_hint를 전혀 참조하지 않는 순수 장식(C212)이지만, pine2js는
    // C415부터 이 문자열을 analyzer.ts containerKindFromTypeHint(resolveContainerExprKind/
    // analyzeVarDecl)가 컨테이너 종류(array/map) 확정에 실제로 소비한다 — 값이 인식된 생성자
    // 콜이 아니어도(`var array<T> x = na` 후 조건부 재할당 등) 이 typeHint만으로 for-in 등이
    // 동작 가능해짐(inferNumType/explicitUdtType 등 기존 소비처는 여전히 이 문자열과 안 매치).
    // C660: `var simple = ...`/`var series = ...` -- SERIES/SIMPLE 한정자 키워드 뒤에 아무 타입도
    // 없이 바로 ASSIGN이 오면(아래 qualifier 분기가 기대하는 "base type IDENTIFIER"가 없음) 그
    // 토큰 자체가 변수 "이름"이다(parseFuncParam C558과 동일 원리 — isBareNameQualifier 주석 참조).
    const qualifierIsBareVarName = this.isBareNameQualifier(this.peek().type) && this.peek(1).type === "ASSIGN";
    if ((this.check("SERIES") || this.check("SIMPLE") || this.check("CONST")) && !qualifierIsBareVarName) {
      // 타입 한정자 접두: `var series float x = ...`/`var simple int y = ...`/`var const bool z = ...`.
      // pine2py parser.py _parse_var_decl(L220-225) 분기 literal port -- 단 pine2py는 type_hint를
      // "qualifier basetype" 합성 문자열("series float")로 저장하지만(codegen이 안 씀, 순수 장식),
      // pine2js는 varTypeHints를 int/string/enum/UDT 판별에 실제로 쓰는 소비자가 있고(inferNumType
      // 등, 전부 정확 문자열 매치) 합성하면 그 매치가 깨진다(`var series string x = na`가 "string"과
      // 안 맞아 na->null 특수화를 놓치는 등) -- qualifier를 버리고 base type만 저장해 기존 무한정자
      // `var TYPE x = ...`와 동일한 typeHint로 낙착시킨다(qualifier 자체가 pine2js 어디서도
      // 소비되지 않는 순수 파서 단계 정보라 이 단순화는 관측 가능한 코드젠 차이 없음, divergence 아님).
      this.advance(); // qualifier 토큰(series/simple/const) 소비만 하고 버림
      const base = this.expect("IDENTIFIER", "in var declaration (qualifier base type)").value;
      if (this.check("LBRACKET") && this.peek(1).type === "RBRACKET") {
        // 한정자 + 대괄호-접미 배열 shorthand: `var simple string[] sec = ...` (wild 8건 —
        // `simple string[] sec = array.new<string>(15)` 근접 중복 6파일 + `const string[]`/
        // `var const int[]` 각 1파일). 위 대괄호-shorthand 단독 분기(L954 이하)와 동일하게
        // array<base>로 정규화 -- qualifier는 위와 동일 이유로 버린다.
        this.advance(); // '['
        this.advance(); // ']'
        typeHint = `array<${base}>`;
      } else {
        typeHint = base;
      }
    } else if (this.check("IDENTIFIER") && this.peek(1).type === "LT" && this.isGenericTypedVarDecl()) {
      // 제네릭 타입 표기: `var array<float> x = ...`/`var map<string, int> m = ...`. pine2py
      // parser.py _parse_var_decl(L226-228) 분기 literal port -- UDT 필드(parseFieldTypeHint)가
      // 이미 만드는 동일한 재귀 합성 문자열("array<float>", 중첩 "matrix<array<float>>")을 그대로
      // 재사용한다(둘 다 pine2py _parse_type_expression과 동일한 콤마-구분 인자 조립 규칙이라
      // 포맷이 일치 -- 대괄호 shorthand가 위에서 정규화하는 타깃 포맷과도 동일).
      typeHint = this.parseFieldTypeHint();
    } else if (
      this.check("IDENTIFIER") &&
      this.peek(1).type === "LBRACKET" &&
      this.peek(2).type === "RBRACKET" &&
      this.peek(3).type === "IDENTIFIER"
    ) {
      const base = this.advance().value; // 타입명
      this.advance(); // '['
      this.advance(); // ']'
      typeHint = `array<${base}>`;
    } else if (
      this.check("IDENTIFIER") &&
      this.peek(1).type === "DOT" &&
      this.peek(2).type === "IDENTIFIER" &&
      this.peek(3).type === "LBRACKET" &&
      this.peek(4).type === "RBRACKET"
    ) {
      // 점 접근 타입(`chart.point`) + 대괄호-접미 배열 shorthand: `var chart.point[] arr = ...`
      // (C486/C487이 이미 지원하는 dotted 타입을 var 선언 위치에도 대칭 확장, wild "expected ASSIGN
      // got DOT" 클러스터, C518). parseFieldTypeHint가 dot-chain을 전부 삼켜 "chart.point"를 만들고,
      // 그 뒤 대괄호는 위 shorthand 분기와 동일하게 수동 소비한다.
      const base = this.parseFieldTypeHint();
      this.advance(); // '['
      this.advance(); // ']'
      typeHint = `array<${base}>`;
    } else if (
      this.check("IDENTIFIER") &&
      this.peek(1).type === "DOT" &&
      this.peek(2).type === "IDENTIFIER" &&
      this.peek(3).type === "IDENTIFIER"
    ) {
      // 점 접근 타입(`chart.point`), 배열 아님: `var chart.point p = ...`. parseAssignmentOrExpr의
      // 동일 dot-chain lookahead(C487)를 var 선언에도 대칭 확장 — 이 분기가 없으면 "chart"가 그대로
      // nameTok으로 소비돼 뒤이은 '.'에서 "expected ASSIGN got DOT" 파스 에러가 난다. 라이브러리
      // import 타입(`qt.QTConfig` 등)도 같은 문법으로 파싱은 되지만 analyzer가 별도로 미지원 처리한다
      // (파서는 문법만, 의미는 analyzer — C126 원칙).
      typeHint = this.parseFieldTypeHint();
    } else if (
      this.check("IDENTIFIER") &&
      (this.peek(1).type === "IDENTIFIER" || KEYWORD_AS_ATTR.has(this.peek(1).type) || this.isBareNameQualifier(this.peek(1).type))
    ) {
      typeHint = this.advance().value;
    }
    // C765 next_hint: var 선언 이름 자리도 KEYWORD_AS_ATTR(parseFuncParam/parseTypeField와 동일 근거,
    // wild `var strategy = ...`류)까지 대칭 확장 -- 이름은 여기서 토큰을 직접 advance해 문자열로만
    // 쓰므로(재파싱 없음) 전체 집합을 그대로 재사용해도 안전.
    const nameTok = KEYWORD_AS_ATTR.has(this.peek().type) || this.isBareNameQualifier(this.peek().type)
      ? this.advance()
      : this.expect("IDENTIFIER", "in var declaration");
    this.expect("ASSIGN", "in var declaration (expected '=')");
    const value = this.parseExpr();
    return {
      kind: "VarDecl",
      name: nameTok.value,
      persistent: true,
      typeHint,
      value,
      line: kw.line,
      col: kw.col,
    };
  }

  private parseAssignmentOrExpr(): Assignment | ExprStmt | FieldAssignment {
    const start = this.peek();
    // 타입 힌트 접두 신규 로컬 선언: `float x = 1.0` (var 없는 '=' 로컬) — pine2py
    // _parse_identifier_statement(parser.py L324-332)의 "타입 힌트 + 변수 선언" 분기 literal
    // port. pine2py codegen._gen_var_decl(L436)은 var_type이 이 분기가 만드는 값(None)이면
    // type_hint를 전혀 참조하지 않고 `name = value`만 방출한다(소스 대조 확인) — 이 타입
    // 힌트는 pine2py 자신에게도 순수 장식이라 codegen 출력엔 영향이 없다(기존 무타입 '=' 로컬과
    // 동일한 codegen 경로). 이 lookahead가 없으면 "float"가 별개의 미해결 ExprStmt(Identifier)로
    // 떨어져 나가 analyzer가 "알 수 없는 식별자"로 거부한다(corpus transpile_fail 최다빈도
    // 클러스터, next_hint 1순위). **C386**: codegen에겐 여전히 장식이지만, analyzer가 UDT 필드
    // 접근 판별에 쓸 수 있도록 Assignment.typeHint로 보존한다(VarDecl.typeHint와 동일 원칙) —
    // wild corpus에 `OrderBlockInfo info = ob.info`처럼 non-var 로컬에 UDT 타입힌트를 붙이는
    // 관용구가 흔해(namespace-access-requires-call 클러스터의 최대 하위 원인, scratch/
    // probe_typed_local_decl.mjs 실측), 이전엔 이 힌트가 통째로 버려져 UDT 필드 접근이 전부
    // "네임스페이스 접근은 호출식만 지원" 최종 에러로 오판됐었다.
    let typeHint: string | null = null;
    // C558: qualifier(series/simple/const) + 정확히 한 개의 IDENTIFIER + ASSIGN(`series x = 1`류) --
    // 아래 qualifier 분기(4-토큰: qualifier TYPE name =)와 peek(1)까지는 겹치지만 name 토큰이
    // 없어 그 분기에 못 들어간다. parseFuncParam(같은 C558)이 문맥상 모호함이 없는 함수 파라미터
    // 자리에서는 "qualifier 자체가 이름"으로 허용했지만, 이 statement 자리는 다르다 -- qualifier
    // 뒤에 identifier가 하나 더 있다는 것 자체가 "타입은 쓰고 이름을 빠뜨렸다"는 신호이지 "qualifier가
    // 곧 변수명"이라는 신호가 아니다(파라미터 자리는 그 뒤에 아무것도 안 남아야 이름-자격이 성립,
    // 위 parseFuncParam seriesOrSimpleIsBareName 가드와 대칭). 이 가드가 없으면 parsePrimary가
    // 이제(C558) "series"를 bare Identifier로 받아들여 "series"만의 ExprStmt + 별개의 "x = 1"
    // Assignment 두 문장으로 조용히 쪼개진다(C212와 동일한 침묵 오분할 클래스) -- 명시적으로
    // 하드 에러를 내 기존 "series x = 1은 무효 문법" 계약(테스트)을 유지한다.
    if (
      (this.check("SERIES") || this.check("SIMPLE") || this.check("CONST")) &&
      this.peek(1).type === "IDENTIFIER" &&
      this.peek(2).type === "ASSIGN"
    ) {
      throw new ParseError(
        `한정자('${this.peek().value}') 뒤에 타입과 변수 이름이 모두 필요함 — 타입을 빠뜨렸다면 'series TYPE name = ...' 형태로 쓸 것`,
        this.peek().line,
        this.peek().col,
      );
    }
    if (
      (this.check("SERIES") || this.check("SIMPLE") || this.check("CONST")) &&
      this.peek(1).type === "IDENTIFIER" &&
      this.peek(2).type === "LBRACKET" &&
      this.peek(3).type === "RBRACKET" &&
      this.peek(4).type === "IDENTIFIER" &&
      this.peek(5).type === "ASSIGN"
    ) {
      // 한정자 + 대괄호-접미 배열 shorthand 신규 로컬: `simple string[] sec = array.new<string>(15)`
      // (var 없음, wild 8건 — parseVarDecl 자매 분기(위)와 동일 근거/정규화). peek(2) 토큰이
      // LBRACKET이라 바로 아래 "qualifier+IDENTIFIER+IDENTIFIER+ASSIGN" 4-토큰 분기와 겹치지 않는다.
      this.advance(); // qualifier
      const base = this.advance().value; // 타입명
      this.advance(); // '['
      this.advance(); // ']'
      typeHint = `array<${base}>`;
    } else if (
      (this.check("SERIES") || this.check("SIMPLE") || this.check("CONST")) &&
      this.peek(1).type === "IDENTIFIER" &&
      this.peek(2).type === "IDENTIFIER" &&
      this.peek(3).type === "ASSIGN"
    ) {
      // 타입 한정자 접두 신규 로컬: `series float x = 1.0`/`simple int y = 1`/`const bool z = true`
      // (var 없음). pine2py _parse_qualified_var_decl(parser.py L274-292, _parse_statement
      // L188-190에서 최상위 분기로 직접 디스패치)의 literal port -- qualifier는 parseVarDecl과
      // 동일 이유로 버리고 base type만 typeHint로 보존한다(qualifier 자체는 pine2js 어디서도
      // 소비되지 않는 순수 파서 단계 정보).
      this.advance(); // qualifier
      typeHint = this.advance().value; // base type
    } else if (this.check("IDENTIFIER") && this.peek(1).type === "LT" && this.isGenericTypedVarDecl()) {
      // 제네릭 타입 표기 + 신규 로컬: `array<float> arr = array.new_float(0)` (var 없음).
      // pine2py _parse_identifier_statement(parser.py L306-313) 동일 분기 literal port --
      // parseVarDecl의 제네릭 분기와 동일하게 조립된 문자열을 typeHint로 보존 -- C415부터
      // analyzer.ts containerKindFromTypeHint(analyzeAssignment)가 이 문자열로 컨테이너 종류
      // (array/map, array<UDT> 원소 타입 포함)를 확정하는 실제 소비처가 됨(VarDecl과 대칭 유지).
      typeHint = this.parseFieldTypeHint();
    } else if (
      this.check("IDENTIFIER") &&
      this.peek(1).type === "DOT" &&
      this.peek(2).type === "IDENTIFIER" &&
      this.peek(3).type === "IDENTIFIER" &&
      this.peek(4).type === "ASSIGN"
    ) {
      // C487 해소: 한정자 없는 dotted 타입 신규 로컬 선언: `chart.point end = expr` (var 없음).
      // parseFuncParam L521(C486)의 동일 dot-chain lookahead 이식 -- 이 고정 4-토큰 패턴은
      // dotted 타입이 표현식으로 이어지는 형태(`chart.point.new(...)`처럼 DOT IDENTIFIER 뒤에
      // 또 DOT/LPAREN이 옴)와 겹치지 않아 lookahead만으로 안전하게 확정된다. 이 분기가 없으면
      // parseExpr()이 "chart.point"까지만 DotAccess로 파싱하고 멈춰(C212와 동일하게) 문장이
      // 조용히 둘로 쪼개진다(bare DotAccess ExprStmt + 별개 무타입 Assignment).
      typeHint = this.parseFieldTypeHint();
    } else if (
      this.check("IDENTIFIER") &&
      this.peek(1).type === "DOT" &&
      this.peek(2).type === "IDENTIFIER" &&
      this.peek(3).type === "LBRACKET" &&
      this.peek(4).type === "RBRACKET" &&
      this.peek(5).type === "IDENTIFIER" &&
      this.peek(6).type === "ASSIGN"
    ) {
      // 점 접근 타입(`chart.point`) + 대괄호-접미 배열 shorthand + 신규 로컬(var 없음):
      // `chart.point[] points = array.new<chart.point>()` (wild, C754). parseVarDecl(위 C518
      // 분기)의 동일 dotted+bracket 정규화를 var 없는 신규 로컬 선언에도 대칭 확장 -- 이 분기가
      // 없으면 "chart"가 DotAccess로 파싱되다 뒤이은 "["에서 parseExpr이 히스토리 인덱스를
      // 기대해 "예상치 못한 토큰 RBRACKET"으로 하드 에러가 난다.
      const base = this.parseFieldTypeHint();
      this.advance(); // '['
      this.advance(); // ']'
      typeHint = `array<${base}>`;
    } else if (
      this.check("IDENTIFIER") &&
      (this.peek(1).type === "IDENTIFIER" || this.isPrimaryBareNameToken(this.peek(1).type) || this.isBareNameQualifier(this.peek(1).type)) &&
      this.peek(2).type === "ASSIGN"
    ) {
      typeHint = this.advance().value;
    } else if (
      // 타입 힌트만 있고 초기값 없는 신규 로컬 선언(초기화 생략, var 없음): `float x`/`string y`처럼
      // '=' 없이 타입+이름만 있으면 암시적으로 na로 초기화된다(GOAL.md na 시맨틱대로 codegen이
      // 숫자/참조형을 이미 갈라 처리하는 기존 'TYPE name = na' 명시적 폼과 완전히 동일한 AST로
      // desugar -- 이 분기는 그 값 노드만 합성). pine2py _parse_identifier_statement(parser.py
      // L324-334)는 이 분기가 아예 없어(ASSIGN 필수) pine2py 자신도 "TYPE"과 "name"을 두 개의
      // 별개 ExprStmt로 조용히 쪼갠다(C212급 latent 버그, python 직접 실행으로 재현 확인 --
      // literal port 불가, DIVERGENCES에 TV 미검증(가설)로 등재). 안전 조건: 두 IDENTIFIER 바로
      // 뒤가 문장의 끝(NEWLINE/DEDENT/EOF/COMMA)일 때만 -- "두 개의 독립된 bare-identifier
      // 문장이 우연히 한 줄에 붙어있는" 경우와의 충돌 위험은 극히 희귀해 무시한다.
      this.check("IDENTIFIER") &&
      (this.peek(1).type === "IDENTIFIER" || this.isPrimaryBareNameToken(this.peek(1).type) || this.isBareNameQualifier(this.peek(1).type)) &&
      (this.peek(2).type === "NEWLINE" ||
        this.peek(2).type === "DEDENT" ||
        this.peek(2).type === "EOF" ||
        this.peek(2).type === "COMMA")
    ) {
      const nameTok2 = this.peek(1);
      const typeTok = this.advance(); // 타입명
      this.advance(); // 변수명
      return {
        kind: "Assignment",
        name: nameTok2.value,
        operator: "=",
        value: { kind: "NaLiteral", line: nameTok2.line, col: nameTok2.col },
        typeHint: typeTok.value,
        line: start.line,
        col: start.col,
      };
    } else if (
      // 대괄호-접미 배열 타입 shorthand + 신규 로컬: `float[] arr = array.new_float(0)` (var
      // 없음). pine2py _parse_identifier_statement L316-317의 동일 분기 literal port --
      // parseVarDecl의 대괄호 shorthand 분기와 동일하게 "array<base>"로 정규화해 보존.
      this.check("IDENTIFIER") &&
      this.peek(1).type === "LBRACKET" &&
      this.peek(2).type === "RBRACKET" &&
      this.peek(3).type === "IDENTIFIER" &&
      this.peek(4).type === "ASSIGN"
    ) {
      const base = this.advance().value; // 타입명
      this.advance(); // '['
      this.advance(); // ']'
      typeHint = `array<${base}>`;
    }
    const expr = this.parseExpr();
    // UDT 필드 대입: `obj.field := value`. Pine 문법상 필드 대입은 ':='만 허용(변수 재대입과
    // 동일하게 "이미 존재하는 바인딩의 갱신" — '='는 새 선언 전용이라 DotAccess 타깃엔 없음).
    if (this.check("WALRUS") && expr.kind === "DotAccess") {
      this.advance();
      const value = this.parseExpr();
      return {
        kind: "FieldAssignment",
        object: expr.obj,
        field: expr.attr,
        value,
        line: start.line,
        col: start.col,
      };
    }
    if ((this.check("ASSIGN") || this.check("WALRUS")) && expr.kind === "Identifier") {
      const opTok = this.advance();
      const value = this.parseExpr();
      return {
        kind: "Assignment",
        name: (expr as Identifier).name,
        operator: opTok.type === "WALRUS" ? ":=" : "=",
        value,
        typeHint,
        line: start.line,
        col: start.col,
      };
    }
    // 복합 대입: `x += value` -> `x := x + value` (기존 변수여야 하므로 WALRUS와 동일 시맨틱).
    const compoundOp = expr.kind === "Identifier" ? COMPOUND_ASSIGN_OPS[this.peek().type] : undefined;
    if (compoundOp) {
      const opTok = this.advance();
      const rhs = this.parseExpr();
      const value: BinOp = {
        kind: "BinOp",
        op: compoundOp,
        left: expr,
        right: rhs,
        line: opTok.line,
        col: opTok.col,
      };
      return {
        kind: "Assignment",
        name: (expr as Identifier).name,
        operator: ":=",
        value,
        typeHint: null,
        line: start.line,
        col: start.col,
      };
    }
    // UDT 필드 복합 대입: `obj.field += value` -> `obj.field := obj.field + value` (C261,
    // WALRUS DotAccess 분기와 동일 시맨틱 확장). left는 원본 DotAccess(expr) 자체를 재사용해
    // analyzeExpr가 읽기 시점 값을 그대로 검증하게 한다 -- FieldAssignment.object만 별도로
    // expr.obj를 참조(둘 다 같은 AST 서브트리 공유, object가 Identifier/DotAccess로 제한돼
    // 있어(analyzeFieldAssignment) 부작용 있는 재평가 위험 없음).
    if (expr.kind === "DotAccess") {
      const compoundOpField = COMPOUND_ASSIGN_OPS[this.peek().type];
      if (compoundOpField) {
        const opTok = this.advance();
        const rhs = this.parseExpr();
        const value: BinOp = {
          kind: "BinOp",
          op: compoundOpField,
          left: expr,
          right: rhs,
          line: opTok.line,
          col: opTok.col,
        };
        return {
          kind: "FieldAssignment",
          object: expr.obj,
          field: expr.attr,
          value,
          line: start.line,
          col: start.col,
        };
      }
    }
    return { kind: "ExprStmt", expr, line: start.line, col: start.col };
  }

  private parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const condition = this.parseOr();
    if (this.check("QUESTION")) {
      const qTok = this.advance();
      const trueExpr = this.parseExpr();
      this.expect("COLON", "in ternary expression (expected ':')");
      const falseExpr = this.parseExpr();
      return {
        kind: "TernaryOp",
        condition,
        trueExpr,
        falseExpr,
        line: qTok.line,
        col: qTok.col,
      } satisfies TernaryOp;
    }
    return condition;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.check("OR")) {
      const opTok = this.advance();
      const right = this.parseAnd();
      left = { kind: "BinOp", op: "or", left, right, line: opTok.line, col: opTok.col } satisfies BinOp;
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.check("AND")) {
      const opTok = this.advance();
      const right = this.parseNot();
      left = { kind: "BinOp", op: "and", left, right, line: opTok.line, col: opTok.col } satisfies BinOp;
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.check("NOT")) {
      const opTok = this.advance();
      const operand = this.parseNot();
      return { kind: "UnaryOp", op: "not", operand, line: opTok.line, col: opTok.col } satisfies UnaryOp;
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    for (;;) {
      const op = COMPARISON_OPS[this.peek().type];
      if (!op) break;
      const opTok = this.advance();
      const right = this.parseAdditive();
      left = { kind: "BinOp", op, left, right, line: opTok.line, col: opTok.col } satisfies BinOp;
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.check("PLUS") || this.check("MINUS")) {
      const opTok = this.advance();
      const right = this.parseMultiplicative();
      left = {
        kind: "BinOp",
        op: opTok.type === "PLUS" ? "+" : "-",
        left,
        right,
        line: opTok.line,
        col: opTok.col,
      } satisfies BinOp;
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.check("STAR") || this.check("SLASH") || this.check("PERCENT")) {
      const opTok = this.advance();
      const right = this.parseUnary();
      left = {
        kind: "BinOp",
        op: opTok.type === "STAR" ? "*" : opTok.type === "SLASH" ? "/" : "%",
        left,
        right,
        line: opTok.line,
        col: opTok.col,
      } satisfies BinOp;
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.check("MINUS")) {
      const opTok = this.advance();
      const operand = this.parseUnary();
      return { kind: "UnaryOp", op: "-", operand, line: opTok.line, col: opTok.col } satisfies UnaryOp;
    }
    // 단항 +: 값에 영향 없는 no-op(pine2py parser.py `_parse_unary`의 PLUS 분기와 동일 — 토큰만
    // 소비하고 버림, AST 노드를 만들지 않음). C195 감사에서 MINUS만 처리되고 PLUS는 parsePrimary까지
    // 떨어져 "예상치 못한 토큰 PLUS"로 죽는 것을 발견해 함께 수정.
    if (this.check("PLUS")) {
      this.advance();
      return this.parseUnary();
    }
    return this.parsePostfix();
  }

  // 호출 인자 하나를 파싱해 위치 인자면 args에, 키워드 인자(`name=value`)면 kwargs에 담는다
  // (pine2py parser.py `_parse_args_kwargs`와 동일한 1-토큰 lookahead 발상). ':='(WALRUS)이
  // 아니라 '='(ASSIGN)만 키워드 인자로 인식해야 `a == b`(EQ, 별도 토큰)나 필드 대입 문법과
  // 겹치지 않는다 — tokens.ts가 이미 '=='/'='을 EQ/ASSIGN으로 분리해뒀으므로 여기선 그 구분을
  // 그대로 재사용하기만 하면 된다. 키워드 인자의 실제 의미(필드 이름 검증 등)는 analyzer가
  // UDT `.new()` 호출에서만 부여 — 파서는 문법만 인식하고 다른 호출에서의 kwargs 사용은
  // analyzer가 하드 에러로 거부한다.
  // SERIES도 IDENTIFIER와 동일하게 kwarg 이름 자리에서 인식(C313, wild 최다 클러스터
  // "예상치 못한 토큰 SERIES" 331/339건이 `plot(series=x, ...)` 폼 — "series"가 plot()/
  // plotshape()/plotchar() 등의 실제 TV 첫 위치 인자 이름인데 우리 렉서가 타입 한정자
  // 키워드로도 예약해(tokens.ts KEYWORDS)둬서 kwarg 이름으로 못 씀. 이 위치는 KEYWORD_AS_ATTR와
  // 동일하게 '=' 직전이라는 문맥이 이미 모호성을 없애므로(DOT 뒤 attr 자리와 동형) 새 문법
  // 충돌 없이 토큰 타입만 넓히면 된다. simple/const는 wild 실사용 0건이라 큐레이션 원칙(C283)에
  // 따라 미포함 — 실사용이 관측되면 그때 추가할 것.
  // TYPE도 동일 원리로 추가(C322, wild `strategy.risk.max_drawdown(value=x, type=strategy.cash)`
  // — "type"이 이 함수의 실제 TV 두 번째 위치 인자 이름인데 우리 렉서의 TYPE 예약어(함수 파라미터
  // 타입힌트 자리, parseFuncParam L495 C314)와 충돌. 함수 파라미터 자리는 이미 KEYWORD_AS_ATTR로
  // 해소돼 있어(C314) 여기서도 그 집합을 재사용하지 않고 SERIES와 동일하게 개별 토큰만 좁게
  // 추가한다 — C283 큐레이션 원칙대로 wild 실사용이 확인된 토큰만(KEYWORD_AS_ATTR 전체를
  // 예방적으로 여기 넓히지 않음).
  private parseCallArgument(args: Expr[], kwargs: CallKwarg[]): void {
    if ((this.check("IDENTIFIER") || this.check("SERIES") || this.check("TYPE")) && this.peek(1).type === "ASSIGN") {
      const nameTok = this.advance();
      this.advance(); // '='
      const value = this.parseExpr();
      kwargs.push({ name: nameTok.value, value, line: nameTok.line, col: nameTok.col });
      return;
    }
    args.push(this.parseExpr());
  }

  private parsePostfix(): Expr {
    let node = this.parsePrimary();
    for (;;) {
      // DEDENT 직후는 항상 새 문장(들여쓰기 감소는 블록 종료에서만 발생) — switch/if를
      // 표현식으로 쓴 primary(제어문-식)가 여러 줄 블록을 소비하고 반환했을 때, 그 직후
      // 토큰이 우연히 '.'/'['/'('이면 이전엔 이 postfix 체인의 연속으로 잘못 삼켰다(C459,
      // wild `[a,b,c] = ta.macd(...)`가 직전 switch/if 블록 DEDENT 바로 뒤에 와서
      // "expected RBRACKET, got COMMA"로 오분류). 같은 물리 라인이 아니면 postfix가
      // 이어질 수 없다는 TV 문법 불변식을 DEDENT 경계로 직접 강제한다.
      if (this.pos > 0 && this.tokens[this.pos - 1]!.type === "DEDENT") break;
      if (this.check("DOT")) {
        const dotTok = this.advance();
        const attrTok =
          KEYWORD_AS_ATTR.has(this.peek().type) || this.isBareNameQualifier(this.peek().type)
            ? this.advance()
            : this.expect("IDENTIFIER", "after '.'");
        node = { kind: "DotAccess", obj: node, attr: attrTok.value, line: dotTok.line, col: dotTok.col };
        continue;
      }
      // 제네릭 타입 인자 호출: `map.new<string, float>()`(map.* 전용 구문, C89). `<...>` 뒤에
      // 즉시 '('가 오는지 lookahead로 먼저 확인해야 `a.b < c`류의 실제 비교 연산과 구분된다
      // (pine2py _is_generic_func_call과 동일 발상). DotAccess 뒤에서만 시도해 순수 식별자 비교
      // (`x < y`)는 절대 이 분기를 타지 않는다. 타입 인자는 보통 런타임에서 안 쓰므로(JS는 완전히
      // 동적 타입) 통째로 버리지만, `array.new<TYPE>(...)`(C221, corpus 144건 중 137건이 float)만은
      // 예외 — new_float/new_int/new_bool/new_string/new_color 5종이 서로 다른 기본값을 갖는 별개
      // 런타임 생성자라 타입 인자를 버리면 analyzer가 어느 쪽으로 라우팅할지 알 수 없다. 이
      // 콜사이트(정확히 5종 원시 타입일 때만)만 attr을 'new_float' 등으로 재작성해 기존
      // ARRAY_REGISTRY suffix 라우팅을 그대로 재사용한다(신규 analyzer/codegen 분기 불필요).
      // label/UDT/`chart.point` 같은 참조형 타입 인자(C230, corpus 4건 실측)는 5종 원시 타입이
      // 아니므로 isArrayNewPrimitiveTypeArg()가 false지만, isArrayNewGenericTypeArg()가 그 구조
      // (단일/점-한개 IDENTIFIER)만 확인해 attr을 'new_generic' 하나로 통일 라우팅 — pine2py도
      // 이 경우 T와 무관하게 동일한 무타입 단일 생성자로 라우팅해(_strip_generic) T별 분기가 없다.
      // 그 밖의 형태(중첩 제네릭 등)만 기존 skipGenericArgs 폴백으로 남는다.
      if (node.kind === "DotAccess" && this.check("LT") && this.isGenericCallLookahead()) {
        if (node.obj.kind === "Identifier" && node.obj.name === "array" && node.attr === "new") {
          if (this.isArrayNewPrimitiveTypeArg()) {
            node.attr = `new_${this.consumeArrayNewTypeArg()}`;
          } else if (this.isArrayNewGenericTypeArg()) {
            const elemTypeName = this.consumeArrayNewGenericTypeArg();
            node.attr = "new_generic";
            node.genericElemType = elemTypeName;
          } else {
            this.skipGenericArgs();
          }
        } else if (node.obj.kind === "Identifier" && node.obj.name === "matrix" && node.attr === "new") {
          // `matrix.new<T>(rows, cols, initial)`(C618, wild `matrix.new<line>(4,13,line(na))`류) —
          // matrix엔 array의 new_float 등 타입별 전용 생성자가 없어(MATRIX_REGISTRY는 "new" 하나뿐)
          // attr 재작성이 필요 없다. T를 genericElemType으로만 보존해 analyzer가 원소가
          // drawing/UDT 핸들인지 판별할 수 있게 한다(array.new<UDT>()의 new_generic 분기와 동일
          // isArrayNewGenericTypeArg/consumeArrayNewGenericTypeArg 재사용 — 이름은 array 전용처럼
          // 보이지만 실제로는 "'<' IDENTIFIER ... '>' 소비 + 첫 세그먼트 기록"뿐인 순수 구조 헬퍼).
          if (this.isArrayNewGenericTypeArg()) {
            node.genericElemType = this.consumeArrayNewGenericTypeArg();
          } else {
            this.skipGenericArgs();
          }
        } else if (node.obj.kind === "Identifier" && node.obj.name === "map" && node.attr === "new") {
          // `map.new<K, V>()`(C684) — 값 타입 V만 genericElemType으로 보존해 analyzer가 값이
          // drawing/UDT 핸들인지 판별할 수 있게 한다(array.new<T>()/matrix.new<T>()의
          // genericElemType과 동일한 소비 계약 — 키 타입 K는 스칼라라 어떤 소비처도 필요로 하지
          // 않아 보존하지 않는다). V 캡처에 실패하는 변칙 형태는 기존 skipGenericArgs 동작과
          // 동일하게 버리기만 한다(consumeMapNewGenericValueTypeArg가 소비까지 겸함).
          const valueTypeName = this.consumeMapNewGenericValueTypeArg();
          if (valueTypeName !== null) node.genericElemType = valueTypeName;
        } else {
          this.skipGenericArgs();
        }
        continue;
      }
      if (this.check("LPAREN")) {
        if (node.kind !== "Identifier" && node.kind !== "DotAccess") {
          const t = this.peek();
          throw new ParseError("호출 가능한 대상이 아님", t.line, t.col);
        }
        const parenTok = this.advance();
        const args: Expr[] = [];
        const kwargs: CallKwarg[] = [];
        if (!this.check("RPAREN")) {
          this.parseCallArgument(args, kwargs);
          while (this.match("COMMA")) {
            this.parseCallArgument(args, kwargs);
          }
        }
        this.expect("RPAREN", "to close call arguments");
        node = { kind: "CallExpr", callee: node, args, kwargs, line: parenTok.line, col: parenTok.col } satisfies CallExpr;
        continue;
      }
      // 히스토리 참조: series[n] (예: close[1]). statement 시작의 `[a,b] = expr` 튜플
      // destructure는 isTupleDestructure() lookahead가 이미 statement 레벨에서 가로채므로
      // 여기(이미 파싱된 primary/postfix 뒤에 오는 '[')와는 위치가 겹치지 않는다.
      if (this.check("LBRACKET")) {
        const brTok = this.advance();
        const index = this.parseExpr();
        this.expect("RBRACKET", "to close index expression");
        // C524: `ta.tr[i]`/`ta.obv[1]`류(wild 실측) — 괄호 없는 ta.* 암묵 호출 desugar(아래
        // desugarTaBareImplicitCall)는 이 루프가 완전히 끝난 뒤에만 적용돼, obj 자리에 desugar 전
        // DotAccess가 그대로 IndexAccess.obj로 잡혀 "히스토리 인덱스는 식별자에만 지원" 오분류가
        // 났다(analyzer/index-access.ts가 obj.kind로 판별하는데 CallExpr이 아니라 DotAccess로
        // 보임). obj를 IndexAccess에 담기 직전에 동일 desugar를 선반영해 obj가 항상 이미 정규형
        // (desugar 대상이면 CallExpr)이 되도록 한다.
        node = { kind: "IndexAccess", obj: this.desugarTaBareImplicitCall(node), index, line: brTok.line, col: brTok.col } satisfies IndexAccess;
        continue;
      }
      break;
    }
    return this.desugarTaBareImplicitCall(node);
  }

  // 괄호 없이 쓰는 ta.* 암묵 호출(ta.tr/ta.wad/ta.wvad/ta.iii/ta.obv/ta.pvt/ta.nvi/ta.pvi/
  // ta.accdist — TV 문법상 변수처럼 보이지만 실제로는 인자 없는 함수 호출, pine2py
  // codegen.py TA_IMPLICIT_CALL과 동일 9종 리터럴 포트) + ta.vwap(단일 사례, wild 33건 — 위 9종과
  // 달리 TA_REGISTRY.minArgCount:1(source 필수)이라 0-인자 대신 hlc3 기본 소스 1-인자로 desugar,
  // pine2py wavealgo/ta/vwap.py의 source=None 기본 분기와 동일)를 동등한 CallExpr로 바꾼다. 호출
  // 형태(`ta.tr()`)는 이미 analyzer/codegen 전 구간이 지원하므로, 여기서 desugar하면 그 아래
  // 파이프라인은 전혀 손댈 필요가 없다(array.new<T>/na() 리터럴처럼 파서가 이미 하는 소규모
  // 이름-기반 문법 재작성과 같은 성격). node이 desugar 대상이 아니면 그대로 반환(멱등 — C524가
  // 추가한 LBRACKET 직전 호출과 postfix 루프 종료 후 호출이 같은 노드에 겹쳐 적용돼도 안전).
  private desugarTaBareImplicitCall(node: Expr): Expr {
    if (node.kind !== "DotAccess" || node.obj.kind !== "Identifier" || node.obj.name !== "ta") {
      return node;
    }
    if (TA_BARE_IMPLICIT_CALL_ATTRS.has(node.attr)) {
      return { kind: "CallExpr", callee: node, args: [], kwargs: [], line: node.line, col: node.col } satisfies CallExpr;
    }
    if (node.attr === "vwap") {
      const hlc3Arg: Identifier = { kind: "Identifier", name: "hlc3", line: node.line, col: node.col };
      return { kind: "CallExpr", callee: node, args: [hlc3Arg], kwargs: [], line: node.line, col: node.col } satisfies CallExpr;
    }
    return node;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === "NUMBER") {
      this.advance();
      return { kind: "NumberLiteral", value: Number(t.value), raw: t.value, line: t.line, col: t.col } satisfies NumberLiteral;
    }
    if (t.type === "STRING") {
      this.advance();
      return { kind: "StringLiteral", value: t.value, line: t.line, col: t.col } satisfies StringLiteral;
    }
    if (t.type === "BOOL") {
      this.advance();
      return { kind: "BoolLiteral", value: t.value === "true", line: t.line, col: t.col } satisfies BoolLiteral;
    }
    if (t.type === "COLOR") {
      this.advance();
      return { kind: "ColorLiteral", value: t.value, line: t.line, col: t.col } satisfies ColorLiteral;
    }
    if (t.type === "NA") {
      this.advance();
      // na(expr) 호출: pine2py parser.py _parse_primary(L830-835)과 동일하게 NA 토큰 소비 직후
      // 다음 토큰이 '('면 함수 호출 대상 Identifier로, 그 외(standalone na)는 기존 NaLiteral로
      // 반환한다(1토큰 lookahead) — parsePostfix의 LPAREN 분기가 Identifier/DotAccess만 호출
      // 가능한 대상으로 인정하므로 이 분기가 없으면 `na(x)`가 전부 ParseError였다(next_hint 항목).
      if (this.check("LPAREN")) {
        return { kind: "Identifier", name: "na", line: t.line, col: t.col } satisfies Identifier;
      }
      return { kind: "NaLiteral", line: t.line, col: t.col } satisfies NaLiteral;
    }
    if (
      t.type === "IDENTIFIER" ||
      t.type === "INDICATOR" ||
      t.type === "STRATEGY" ||
      t.type === "LIBRARY" ||
      t.type === "TYPE" ||
      t.type === "SERIES" ||
      t.type === "SIMPLE" ||
      t.type === "METHOD"
    ) {
      // TYPE(`type Foo` UDT 선언 키워드)은 statement 시작 위치에서만 그 의미로 소비되고(parseStatement
      // 가 먼저 가로챔), 여기(표현식 term 위치)에 도달했다는 것 자체가 이미 그 문법이 아니라는 뜻 --
      // "type"이 TV의 흔한 UDF 파라미터 이름이라(C314, `ma(source, length, type) => switch type ...`)
      // 그 값을 본문에서 읽는 bare 참조도 IDENTIFIER와 동일하게 받아야 한다. INDICATOR/STRATEGY/
      // LIBRARY가 이미 같은 이유(지시어 키워드지만 bare 참조도 가능)로 이 화이트리스트에 있던 선례를
      // 재사용(C274). SERIES/SIMPLE도 동일 원리(C558) — 한정자 키워드지만 파라미터 "이름"으로
      // bare 채택된 경우(위 parseFuncParam seriesOrSimpleIsBareName) 함수 본문이 그 이름을 다시
      // 참조하는 위치(`series[i]`/`na(series)`류, wild pctrank 관용구)는 항상 이 term 자리다 --
      // 한정자로서의 의미는 parseFuncParam/parseVarDecl이 먼저 명시적으로 토큰 타입을 확인해
      // 가로채므로(이 분기 도달 자체가 "그 문법이 아님"을 뜻하는 TYPE과 동일 근거) 충돌 없다.
      // METHOD도 동일 원리(C691, wild `methodRiskIndicator(method) => if method == 'Average' ...`)
      // -- "method"가 TV의 UDF 파라미터 이름으로 흔히 쓰이고(parseFuncParam L627이 KEYWORD_AS_ATTR로
      // 이미 파라미터 "이름" 자리는 허용해둠), 그 값을 본문에서 읽는 bare 참조가 이 term 자리에
      // 도달한다 -- statement-start의 진짜 `method name(...) =>` 선언은 parseStatement(L272)가
      // 이미 앞서 가로채므로 여기 도달 자체가 그 문법이 아님을 뜻해 충돌 없음.
      this.advance();
      return { kind: "Identifier", name: t.value, line: t.line, col: t.col } satisfies Identifier;
    }
    if (t.type === "LPAREN") {
      this.advance();
      const inner = this.parseExpr();
      this.expect("RPAREN", "to close parenthesized expression");
      return inner;
    }
    if (t.type === "LBRACKET") {
      return this.parseTupleExpr();
    }
    // 제어문-식(if/for/while/switch as expression, GOAL.md 임시변수 방식): `x = if cond ... else
    // ...` 처럼 VarDecl/Assignment 값 위치에서 등장한다. statement 시작 위치의 if/for/while/switch는
    // parseStatement가 이 지점에 도달하기 전에 먼저 가로채므로 충돌하지 않는다 — 여기 도달하는
    // 경우는 항상 '=' 나 ':=' 뒤, 괄호 안 등 진짜 표현식 위치뿐이다. 파서는 statement-position과
    // 동일한 parseIf/parseFor/parseWhile/parseSwitch를 그대로 재사용해 같은 AST 노드를 만들고,
    // 그 노드가 VarDecl/Assignment 값이 아닌 다른 표현식 위치에 쓰이면 analyzer가 에러로 좁힌다
    // (TupleExpr와 동일한 "파서는 넓게, analyzer가 좁힌다" 패턴).
    if (t.type === "IF") return this.parseIf();
    if (t.type === "FOR") {
      // for-in(ForInStmt)은 Expr 유니온에 없다(위 ForInStmt 주석 참조) — 값 위치에서 만나면
      // 여기서 바로 명시 거부(statement 위치의 for-in은 parseStatement가 별도로 처리해 영향 없음).
      const node = this.parseFor();
      if (node.kind === "ForInStmt") {
        throw new ParseError("for-in 루프는 제어문-식(값) 위치에서 아직 지원하지 않음", node.line, node.col);
      }
      return node;
    }
    if (t.type === "WHILE") return this.parseWhile();
    if (t.type === "SWITCH") return this.parseSwitch();
    throw new ParseError(`예상치 못한 토큰 ${t.type} (${t.value || ""})`, t.line, t.col);
  }

  // [a, b, c] 표현식 파싱(statement-level LHS destructure `[a,b] = expr`는 isTupleDestructure()
  // lookahead가 먼저 가로채므로 여기 도달하지 않음 — 여기는 표현식 위치의 `[...]`만 다룬다,
  // 현재는 UDF 마지막 문장의 튜플 반환 값 하나만 analyzer가 허용한다).
  private parseTupleExpr(): TupleExpr {
    const start = this.expect("LBRACKET", "in tuple expression");
    const elements: Expr[] = [];
    while (!this.check("RBRACKET")) {
      elements.push(this.parseExpr());
      if (this.check("COMMA")) this.advance();
    }
    this.expect("RBRACKET", "to close tuple expression");
    return { kind: "TupleExpr", elements, line: start.line, col: start.col };
  }
}

export function parse(source: string): Script {
  return Parser.parse(source);
}
