// PineScript v5 Lexer. pine2py/src/pine2wave/lexer.py의 검증된 알고리즘을 TS로 포팅
// (들여쓰기 기반 INDENT/DEDENT, // 주석/애노테이션, 줄끝 연산자 line-continuation).

import { KEYWORDS, ONE_CHAR_OPS, TWO_CHAR_OPS, type Token, type TokenType } from "./tokens";

const TAB_WIDTH = 4;

const CONTINUATION_OPS: ReadonlySet<TokenType> = new Set([
  "QUESTION",
  "COLON",
  "PLUS",
  "MINUS",
  "STAR",
  "SLASH",
  "PERCENT",
  "EQ",
  "NEQ",
  "LT",
  "GT",
  "LTE",
  "GTE",
  "ASSIGN",
  "WALRUS",
  "COMMA",
  "AND",
  "OR",
  "NOT",
]);

const LEADING_CONTINUATION_KEYWORDS: ReadonlySet<string> = new Set(["or", "and"]);

// wild 코퍼스 실측(C316): 삼항/산술/비교 연산자를 "다음 줄 맨 앞"에 두는 정렬 스타일(트레일링이
// 아니라 리딩 위치의 줄 연속) — 187건 "예상치 못한 들여쓰기 블록" 클러스터 중 QUESTION/COLON
// 리딩 55건 + PLUS 리딩 22건 + EQ 리딩 1건을 전수 소스 확인. MINUS 리딩(7건)은 전수 확인 결과
// 전부 무관한 별개 아티팩트(장식용 배너/멀티라인 문자열)라 제외 — wild 실사용 없는 형제
// 토큰까지 예방적으로 넓히지 않는다(C283 큐레이션 원칙).
// wild2 코퍼스 실측(C661): `[a, b]\n = f()`류 튜플 디스트럭처(또는 단순 대입)의 `=`를 RHS
// 표현식 앞에 두고 다음 줄로 내려쓰는 정렬 스타일 — "예상치 못한 들여쓰기 블록" 클러스터
// 85건 중 5건 전수 소스 확인(request.security/request.security_lower_tf 다중 반환 대입).
// `=`로 시작하는 줄이 새 top-level 문장일 수는 구조상 없음(대입은 항상 LHS가 선행) — ASSIGN
// 리딩은 안전하게 항상 continuation. C316과 동일 판단(pine2py도 동일 입력에 ParseError,
// TV 미검증(가설) — DIVERGENCES #123 갱신).
// wild2 코퍼스 실측(C756, next_hint(C755)): `bool x = (a - b)\n     >= threshold`류 비교연산자
// 리딩(7e884bbec405, tv_verdict accept). EQ 리딩과 동일 근거(비교 연산자로 시작하는 줄이 새
// top-level 문장일 수 없음) — LT/GT/LTE/GTE/NEQ 전부 대칭 확장.
// wild2 코퍼스 실측(C757, next_hint(C756)): `f_sec(_market ,_res, _exp)\n     => request.security(...)`
// 류 단문 UDF의 `=>`를 다음 줄 맨 앞에 두는 정렬 스타일(3d1d6f1ee9ef/65f8c8a2a893, tv_verdict
// accept, 동일 템플릿 2건). `=>`로 시작하는 줄은 정의상 파라미터 목록 뒤에만 올 수 있어 새
// top-level 문장일 수 없음(ASSIGN/비교연산자 리딩과 동일 근거) — FAT_ARROW 리딩 추가.
// wild2 코퍼스 실측(C758, next_hint(C757)): `dataBuilder.new()\n  .add(...)\n  .add(...)`류
// 메서드 체인의 `.`를 다음 줄 맨 앞에 두는 정렬 스타일(861c5a4caf83/cff5a2f3cdcb, tv_verdict
// accept). `.`로 시작하는 줄은 문법상 항상 선행 표현식의 멤버/메서드 접근이라 새 top-level
// 문장일 수 없음(FAT_ARROW 같은 이중 의미가 없어 폭 가드 불필요) — DOT 리딩 추가. peekLeadingTokenType이
// ".5"류 소수 리터럴(실제 스캐너는 NUMBER로 읽음)을 DOT으로 오인하지 않도록 별도 가드 필요.
// wild2 코퍼스 실측(C759, next_hint(C758)): `a = 0, b = 1, ...\n ,      c = 2, d = 3, ...`류
// 쉼표-구분 다중 대입문(parser.ts parseStatementWithCommas, C304/C319 — "완료된 문장 직후
// COMMA는 물리 줄과 무관하게 항상 문장 구분자"라 파서는 이미 지원)을 트레일링이 아니라 리딩
// 위치에 쉼표를 두고 다음 줄로 내려쓰는 정렬 스타일(fdee238934d1, tv_verdict accept). `,`로
// 시작하는 줄은 문법상 항상 선행 완료된 문장/원소 뒤의 구분자라 새 top-level 문장을 열 수
// 없음(DOT과 동일 근거, 폭/직전토큰 가드 불필요) — COMMA 리딩 추가.
const LEADING_CONTINUATION_SYMBOLS: ReadonlySet<TokenType> = new Set([
  "QUESTION",
  "COLON",
  "PLUS",
  "EQ",
  "NEQ",
  "LT",
  "GT",
  "LTE",
  "GTE",
  "ASSIGN",
  "FAT_ARROW",
  "DOT",
  "COMMA",
]);

export class Lexer {
  private source: string;
  private pos = 0;
  private line = 1;
  private col = 1;
  private tokens: Token[] = [];
  private indentStack: number[] = [0];
  private parenDepth = 0;
  private bracketDepth = 0;
  private inBlockComment = false;
  private lineContinuation = false;
  // C755: 파일의 첫 실질 문장 줄 앞에는 정의상 블록을 여는 헤더가 존재할 수 없다 — 그 줄의
  // 선행 공백(복붙 아티팩트)은 INDENT를 유발하면 안 된다. wild2 corpus tv_verdict 실측(accept)로
  // 확인된 TV 실제 동작(들여쓰기 기준선은 첫 문장에서 확정되지 않고 0 유지).
  private sawFirstIndentCheck = false;
  // C614: 미종료 문자열이 다음 물리 줄로 이어지는 경우(readString) this.lineIdx를 전진시켜
  // 그 줄들을 tokenize()의 개별 tokenizeLine 처리(들여쓰기/주석/줄연속 판정)에서 제외한다.
  private lines: string[] = [];
  private lineIdx = 0;

  constructor(source: string) {
    this.source = source;
  }

  tokenize(): Token[] {
    this.lines = this.source.split("\n");
    for (this.lineIdx = 0; this.lineIdx < this.lines.length; this.lineIdx++) {
      this.line = this.lineIdx + 1;
      this.tokenizeLine(this.lines[this.lineIdx]!);
    }
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.tokens.push({ type: "DEDENT", value: "", line: this.line, col: 0 });
    }
    this.tokens.push({ type: "EOF", value: "", line: this.line, col: 0 });
    return this.tokens;
  }

  private tokenizeLine(rawLine: string): void {
    let line = rawLine;
    if (this.inBlockComment) {
      const closeIdx = line.indexOf("*/");
      if (closeIdx === -1) return;
      this.inBlockComment = false;
      line = " ".repeat(closeIdx + 2) + line.slice(closeIdx + 2);
    }

    const stripped = line.trim();
    if (!stripped) return;

    if (stripped.startsWith("//@")) {
      this.tokens.push({ type: "ANNOTATION", value: stripped, line: this.line, col: 1 });
      return;
    }
    if (stripped.startsWith("//")) return;

    // C756(next_hint(C755)): 공백 split은 `and( vixrsiCondBuy...)`처럼 키워드 뒤에 괄호가
    // 공백 없이 바로 붙으면 "and("를 통째로 한 단어로 뽑아버려 리딩 continuation 키워드
    // 매칭을 놓친다(5a13dcf4bcfe, tv_verdict accept) — 식별자 문자 클래스로만 앞부분을 뽑는
    // 토큰화 기반 매칭으로 교체(뒤에 오는 비-식별자 문자와 무관하게 항상 정확한 키워드를 얻음).
    const firstWord = /^[A-Za-z_][A-Za-z0-9_]*/.exec(stripped)?.[0] ?? "";
    const leadingTokenType = this.peekLeadingTokenType(stripped);
    let isLeadingContinuation =
      LEADING_CONTINUATION_KEYWORDS.has(firstWord) ||
      (leadingTokenType !== null && LEADING_CONTINUATION_SYMBOLS.has(leadingTokenType));
    // C757: FAT_ARROW은 다른 LEADING_CONTINUATION_SYMBOLS 원소와 달리 진짜로 새 문장을 열 수
    // 있다 — switch 문의 default arm(레이블 없는 bare `=> expr`)이 형제 case 레이블과 동일
    // 폭(DEDENT 대상)에서 정당하게 새 줄을 연다(wild 52건 무차별 regression 실측). 폭 비교만으론
    // 부족: subject 없는 `switch`의 유일한 첫 arm(`x = switch\n    => "Static"`)도 진짜 INDENT를
    // 열어야 하는데 폭이 늘어나 오탐한다(추가 2건 실측).
    // C760: switch case-condition을 여러 줄로 쪼개고 '=>'를 다음 줄 맨 앞(더 깊은 폭)에 두는
    // 정렬 스타일(75d378af6ded, tv_verdict accept) — 직전 실토큰이 RPAREN(UDF 시그니처)이 아니라
    // 산술/비교 연산자로 끝나는 case-condition이라 원래의 RPAREN 전용 가드로는 못 잡는다. 단순히
    // "직전 실토큰 != SWITCH"로 넓히면 subject-full switch의 bare 첫 arm(`switch x\n => "default"`,
    // 직전 실토큰이 SWITCH가 아니라 subject 식별자)까지 오분류해 case 자체가 통째로 소실되는
    // regression이 남(synthetic 테스트로 실측 확인). 진짜 구분 신호는 토큰 타입이 아니라 "직전
    // 실토큰이 속한 물리 줄이 switch 헤더 자신인가"이므로, 그 줄 전체를 스캔해 SWITCH 토큰이
    // 있는지 직접 확인한다 — 헤더 줄 자신이면(SWITCH 있음) 진짜 첫 INDENT를 열어야 하니 제외,
    // 이미 헤더를 지난 case-condition 줄이면(SWITCH 없음) continuation 허용.
    if (
      isLeadingContinuation &&
      leadingTokenType === "FAT_ARROW" &&
      this.parenDepth === 0 &&
      this.bracketDepth === 0 &&
      !this.lineContinuation
    ) {
      const [probeWidth] = this.measureIndent(line);
      let lastRealIdx = this.tokens.length - 1;
      while (
        lastRealIdx >= 0 &&
        (this.tokens[lastRealIdx]!.type === "NEWLINE" ||
          this.tokens[lastRealIdx]!.type === "INDENT" ||
          this.tokens[lastRealIdx]!.type === "DEDENT")
      ) {
        lastRealIdx -= 1;
      }
      const prevRealType = lastRealIdx >= 0 ? this.tokens[lastRealIdx]!.type : null;
      let prevLineIsSwitchHeader = false;
      if (lastRealIdx >= 0) {
        let lineStartIdx = lastRealIdx;
        while (
          lineStartIdx > 0 &&
          this.tokens[lineStartIdx - 1]!.type !== "NEWLINE" &&
          this.tokens[lineStartIdx - 1]!.type !== "INDENT" &&
          this.tokens[lineStartIdx - 1]!.type !== "DEDENT"
        ) {
          lineStartIdx -= 1;
        }
        for (let i = lineStartIdx; i <= lastRealIdx; i++) {
          if (this.tokens[i]!.type === "SWITCH") {
            prevLineIsSwitchHeader = true;
            break;
          }
        }
      }
      const looksLikeUdfSignature =
        prevRealType !== null &&
        !prevLineIsSwitchHeader &&
        probeWidth > this.indentStack[this.indentStack.length - 1]!;
      if (!looksLikeUdfSignature) {
        isLeadingContinuation = false;
      }
    }
    let width: number;
    let rawOffset: number;
    if (isLeadingContinuation) {
      while (
        this.tokens.length > 0 &&
        (this.tokens[this.tokens.length - 1]!.type === "NEWLINE" ||
          this.tokens[this.tokens.length - 1]!.type === "INDENT" ||
          this.tokens[this.tokens.length - 1]!.type === "DEDENT")
      ) {
        if (this.tokens[this.tokens.length - 1]!.type === "INDENT") this.indentStack.pop();
        this.tokens.pop();
      }
      this.lineContinuation = true;
      [width, rawOffset] = this.measureIndent(line);
    } else {
      [width, rawOffset] = this.handleIndent(line);
    }

    // pos는 문자열 인덱스이므로 raw 문자 수(rawOffset)를 써야 한다.
    // width는 탭=4칸으로 환산한 시각적 폭이라 탭 들여쓰기에서 pos로 쓰면 어긋난다
    // (pine2py lexer.py도 동일 버그 보유 — 여기서만 의도적으로 수정, GOAL.md 선례 참조).
    this.pos = rawOffset;
    this.col = width + 1;
    this.scanTokens(line);
    this.handleLineEnd();
  }

  // stripped(들여쓰기 제거된) 줄이 실제로 스캔될 첫 토큰의 타입을 미리 판별(2문자 연산자
  // 우선 확인 후 1문자 폴백, scanTokens의 TWO_CHAR_OPS/ONE_CHAR_OPS 조회와 동일 우선순위).
  private peekLeadingTokenType(stripped: string): TokenType | null {
    const two = stripped.slice(0, 2);
    const twoType = TWO_CHAR_OPS[two];
    if (twoType) return twoType;
    const one = stripped[0] ?? "";
    // C758: 실제 스캐너(readNumber 진입 조건)는 "."+숫자를 NUMBER로 읽는다 — ".5"류 소수
    // 리터럴이 DOT 리딩 continuation으로 오분류되지 않도록 대칭 가드.
    if (one === "." && /[0-9]/.test(stripped[1] ?? "")) return null;
    return ONE_CHAR_OPS[one] ?? null;
  }

  private measureIndent(line: string): [width: number, rawOffset: number] {
    let width = 0;
    let rawOffset = 0;
    for (const ch of line) {
      if (ch === " ") {
        width += 1;
        rawOffset += 1;
      } else if (ch === "\t") {
        width += TAB_WIDTH;
        rawOffset += 1;
      } else break;
    }
    return [width, rawOffset];
  }

  private handleIndent(line: string): [width: number, rawOffset: number] {
    const [width, rawOffset] = this.measureIndent(line);

    if (this.parenDepth === 0 && this.bracketDepth === 0 && !this.lineContinuation) {
      if (!this.sawFirstIndentCheck) {
        // 첫 문장 줄은 블록 헤더 뒤일 수 없으므로 그 폭을 기준선(0)으로 흡수 — INDENT 미발생.
        this.sawFirstIndentCheck = true;
      } else if (width > this.indentStack[this.indentStack.length - 1]!) {
        this.indentStack.push(width);
        this.tokens.push({ type: "INDENT", value: "", line: this.line, col: 1 });
      } else {
        while (width < this.indentStack[this.indentStack.length - 1]!) {
          this.indentStack.pop();
          this.tokens.push({ type: "DEDENT", value: "", line: this.line, col: 1 });
        }
      }
    }
    return [width, rawOffset];
  }

  private handleLineEnd(): void {
    if (this.parenDepth !== 0 || this.bracketDepth !== 0) return;
    const last = this.tokens[this.tokens.length - 1];
    if (!last || last.type === "NEWLINE" || last.type === "INDENT" || last.type === "DEDENT") return;
    if (CONTINUATION_OPS.has(last.type)) {
      this.lineContinuation = true;
      return;
    }
    this.lineContinuation = false;
    this.tokens.push({ type: "NEWLINE", value: "\\n", line: this.line, col: this.col });
  }

  private scanTokens(initialLine: string): void {
    let line = initialLine;
    while (this.pos < line.length) {
      const ch = line[this.pos]!;

      if (ch === " " || ch === "\t") {
        this.pos += 1;
        this.col += 1;
        continue;
      }

      if (ch === "/" && line[this.pos + 1] === "/") break;

      if (ch === "/" && line[this.pos + 1] === "*") {
        const closeIdx = line.indexOf("*/", this.pos + 2);
        if (closeIdx !== -1) {
          this.pos = closeIdx + 2;
          this.col = this.pos + 1;
        } else {
          this.inBlockComment = true;
          break;
        }
        continue;
      }

      if (ch === "#" && /[0-9a-fA-F]/.test(line[this.pos + 1] ?? "")) {
        this.readColor(line);
        continue;
      }

      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[this.pos + 1] ?? ""))) {
        this.readNumber(line);
        continue;
      }

      if (ch === '"' || ch === "'") {
        line = this.readString(line, ch);
        continue;
      }

      if (/[A-Za-z_]/.test(ch)) {
        this.readIdentifier(line);
        continue;
      }

      if (this.pos + 1 < line.length) {
        const two = line.slice(this.pos, this.pos + 2);
        const tt = TWO_CHAR_OPS[two];
        if (tt) {
          this.tokens.push({ type: tt, value: two, line: this.line, col: this.col });
          this.pos += 2;
          this.col += 2;
          continue;
        }
      }

      const tt1 = ONE_CHAR_OPS[ch];
      if (tt1) {
        this.trackBracketDepth(ch);
        this.tokens.push({ type: tt1, value: ch, line: this.line, col: this.col });
        this.pos += 1;
        this.col += 1;
        continue;
      }

      // 인식할 수 없는 문자 → 스킵
      this.pos += 1;
      this.col += 1;
    }
  }

  private trackBracketDepth(ch: string): void {
    if (ch === "(") this.parenDepth += 1;
    else if (ch === ")") this.parenDepth = Math.max(0, this.parenDepth - 1);
    else if (ch === "[") this.bracketDepth += 1;
    else if (ch === "]") this.bracketDepth = Math.max(0, this.bracketDepth - 1);
  }

  private readNumber(line: string): void {
    const start = this.pos;
    const startCol = this.col;
    let hasDot = false;

    while (this.pos < line.length) {
      const ch = line[this.pos]!;
      if (/[0-9]/.test(ch)) {
        this.pos += 1;
        this.col += 1;
      } else if (ch === "." && !hasDot) {
        hasDot = true;
        this.pos += 1;
        this.col += 1;
      } else {
        break;
      }
    }

    if (this.pos < line.length && (line[this.pos] === "e" || line[this.pos] === "E")) {
      this.pos += 1;
      this.col += 1;
      if (this.pos < line.length && (line[this.pos] === "+" || line[this.pos] === "-")) {
        this.pos += 1;
        this.col += 1;
      }
      while (this.pos < line.length && /[0-9]/.test(line[this.pos]!)) {
        this.pos += 1;
        this.col += 1;
      }
    }

    const value = line.slice(start, this.pos);
    this.tokens.push({ type: "NUMBER", value, line: this.line, col: startCol });
  }

  // C614: 닫는 따옴표를 같은 줄에서 못 찾으면 다음 물리 줄로 이어 스캔한다 — wild corpus 실측
  // (긴 tooltip 문자열이 줄바꿈 없이 그대로 다음 줄로 이어지는 관용구, "예상치 못한 들여쓰기 블록"
  // 클러스터 상위 원인, 37/112건). pine2py _read_string도 동일하게 줄 단위 한정이라(직접 실행
  // 확인) 오라클 대조 불가 — hand-verified 전용, DIVERGENCES 등재 대상. 반환값은 마지막으로 닿은
  // 물리 줄의 나머지(닫는 따옴표 이후) — scanTokens가 이어서 그 줄을 계속 스캔한다.
  private readString(line: string, quote: string): string {
    const startLine = this.line;
    const startCol = this.col;
    this.pos += 1;
    this.col += 1;
    let curLine = line;
    let start = this.pos;
    let value = "";
    let closed = false;

    while (true) {
      if (this.pos >= curLine.length) {
        value += curLine.slice(start);
        if (this.lineIdx + 1 >= this.lines.length) break; // EOF까지 미종료 — 포기
        value += "\n";
        this.lineIdx += 1;
        this.line = this.lineIdx + 1;
        curLine = this.lines[this.lineIdx]!;
        this.pos = 0;
        this.col = 1;
        start = 0;
        continue;
      }
      if (curLine[this.pos] === quote) {
        value += curLine.slice(start, this.pos);
        closed = true;
        break;
      }
      if (curLine[this.pos] === "\\") {
        this.pos += 1;
        this.col += 1;
      }
      this.pos += 1;
      this.col += 1;
    }

    if (closed) {
      this.pos += 1;
      this.col += 1;
    }
    this.tokens.push({ type: "STRING", value, line: startLine, col: startCol });
    return curLine;
  }

  private readIdentifier(line: string): void {
    const start = this.pos;
    const startCol = this.col;

    while (this.pos < line.length && /[A-Za-z0-9_]/.test(line[this.pos]!)) {
      this.pos += 1;
      this.col += 1;
    }

    const value = line.slice(start, this.pos);
    const tokenType = KEYWORDS[value] ?? "IDENTIFIER";
    this.tokens.push({ type: tokenType, value, line: this.line, col: startCol });
  }

  private readColor(line: string): void {
    const start = this.pos;
    const startCol = this.col;
    this.pos += 1;
    this.col += 1;
    while (this.pos < line.length && /[0-9a-fA-F]/.test(line[this.pos]!)) {
      this.pos += 1;
      this.col += 1;
    }
    const value = line.slice(start, this.pos);
    this.tokens.push({ type: "COLOR", value, line: this.line, col: startCol });
  }
}

export function tokenize(source: string): Token[] {
  return new Lexer(source).tokenize();
}
