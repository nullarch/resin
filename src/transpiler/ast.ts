// PineScript AST 노드. pine2py/src/pine2wave/ast_nodes.py의 노드 어휘를 최소 부분집합으로 이식
// (var/walrus/이항연산/호출/식별자 - 이번 사이클 최소 수직 슬라이스 범위).

export interface Pos {
  line: number;
  col: number;
}

export interface Script extends Pos {
  kind: "Script";
  body: Stmt[];
}

export type Stmt =
  | VarDecl
  | Assignment
  | ExprStmt
  | IfStmt
  | ForStmt
  | ForInStmt
  | WhileStmt
  | SwitchStmt
  | BreakStmt
  | ContinueStmt
  | FuncDecl
  | TupleDestructure
  | TypeDecl
  | FieldAssignment
  | EnumDecl
  | MethodDecl;

// UDT 필드 선언: `type_name field_name [= default]`. Pine 문법상 type_hint는 필드마다 항상
// 명시(pine2py parser.py _parse_type_field — 생략 가능한 var/param typeHint와 다른 지점).
// 이번 슬라이스는 analyzer가 typeHint를 float/int/bool/string/color 5종으로만 제한한다(중첩
// UDT/제네릭 필드는 ROADMAP 별도 항목).
export interface TypeField extends Pos {
  kind: "TypeField";
  name: string;
  typeHint: string;
  default: Expr | null;
}

// UDT 선언: `type Name` + 들여쓰기 필드 블록. 런타임 표현은 plain object(GOAL.md na 3분할
// 규약상 UDT는 참조형 — var 선언의 na는 null)이며, `Name.new(...)` 생성자 호출은 analyzer가
// CallExpr의 DotAccess callee를 이 타입명으로 인식해 처리한다(별도 AST 노드 불필요).
export interface TypeDecl extends Pos {
  kind: "TypeDecl";
  name: string;
  fields: TypeField[];
}

// UDT 필드 대입: `obj.field := value`. Pine은 필드 대입에 ':='만 허용(변수 재대입과 동일하게
// "이미 존재하는 바인딩의 갱신"이라 '='는 문법에 없음). object는 이번 슬라이스에서 analyzer가
// UDT var로 추적된 단순 Identifier만 허용(중첩 접근 `a.b.field`는 ROADMAP 별도 항목).
export interface FieldAssignment extends Pos {
  kind: "FieldAssignment";
  object: Expr;
  field: string;
  value: Expr;
}

// enum 선언: `enum Name` + 들여쓰기 멤버 블록. 각 멤버는 bare identifier 한 줄이거나
// `identifier = "title string"`(C136, TV v5 문법상 멤버 값은 문자열 리터럴로만 제한 — pine2py는
// `_parse_expression()`으로 임의 표현식을 허용하는 더 관대한 구현이지만(Explore 조사로 확인), 이는
// "확인된 버그"가 아니라 단순 관대함이라 GOAL.md "알려진 버그는 따르지 않는다"의 적용 대상이 아님.
// 여기선 실제 TV 문법에 맞춰 의도적으로 문자열 리터럴만 허용). title은 값 비교/switch 시맨틱에
// 관여하지 않는 순수 표시 메타데이터 — 멤버 접근(Direction.long)은 별도 AST 노드 없이 DotAccess로
// 파싱되고, analyzer가 title과 무관하게 항상 컴파일타임에 "EnumName.MemberName" qualified 문자열로
// 접는다(color.* 상수와 동일한 builtinStringConstants 재사용, DIVERGENCES.md #55 그대로 유지).
export interface EnumMember extends Pos {
  kind: "EnumMember";
  name: string;
  title: string | null;
}

export interface EnumDecl extends Pos {
  kind: "EnumDecl";
  name: string;
  members: EnumMember[];
}

export interface VarDecl extends Pos {
  kind: "VarDecl";
  name: string;
  persistent: boolean; // var/varip 키워드 존재 여부
  typeHint: string | null;
  value: Expr;
}

export interface Assignment extends Pos {
  kind: "Assignment";
  name: string;
  operator: "=" | ":=";
  value: Expr;
  // var 없는 '=' 신규 로컬 선언의 타입힌트 접두(`Type x = expr`, C386) — codegen에겐 여전히
  // 순수 장식(pine2py도 참조 안 함, 위 parseAssignmentOrExpr 주석 참조)이지만 analyzer가 UDT
  // 필드 접근 판별(explicitUdtType, analyzeVarDecl과 동일 원칙)에 쓴다. 그 외 형태(':=' 재대입/
  // 복합대입)는 항상 null.
  typeHint: string | null;
}

export interface ExprStmt extends Pos {
  kind: "ExprStmt";
  expr: Expr;
}

// if/elif/else. statement 위치뿐 아니라 VarDecl/Assignment의 값 위치(제어문-식, `x = if ... else
// ...`)에서도 쓰인다 — 그래서 Expr 유니온에도 이 노드가 그대로 들어간다(파서는 IfStmt 하나만 만들고,
// 그게 어느 위치에 나타났는지로 의미가 갈린다: 나머지 위치는 analyzer가 에러로 좁힘, TupleExpr와
// 동일한 "파서는 넓게, analyzer가 좁힌다" 패턴). GOAL.md "제어문-식은 임시변수+제어문으로"에 따라
// codegen은 IIFE 없이 결과를 담을 임시변수에 각 분기 마지막 표현식을 대입하는 코드를 생성한다.
export interface IfStmt extends Pos {
  kind: "IfStmt";
  condition: Expr;
  thenBody: Stmt[];
  elifClauses: { condition: Expr; body: Stmt[] }[];
  elseBody: Stmt[] | null;
}

// 숫자 범위 for만 지원: `for i = start to end [by step]`.
// `for ... in array`/튜플 destructure는 array 빌트인(P2)과 함께 별도 구현.
// IfStmt와 동일하게 값 위치(제어문-식)에서도 쓰인다 — 위 IfStmt 주석 참조.
export interface ForStmt extends Pos {
  kind: "ForStmt";
  varName: string;
  start: Expr;
  end: Expr;
  step: Expr | null;
  body: Stmt[];
}

// `for x in arr` / `for [idx, val] in arr` — 배열 순회 for-in 루프(pine2py ast_nodes.py
// ForInStmt literal port). ForStmt/IfStmt/WhileStmt/SwitchStmt와 달리 **Expr 유니온에는
// 넣지 않는다**: pine2py parser.py _parse_for는 statement 위치와 제어문-식(값) 위치 양쪽에서
// 재사용되지만(L392/L864), for-in이 값 위치에 실제로 쓰이는 corpus 근거가 없어 이번 슬라이스는
// statement 위치만 지원 — parser.ts의 값-위치 진입점(primary())은 for-in을 만나면 ParseError로
// 명시 거부한다(범위를 넓히려면 이 타입을 Expr에도 추가하고 관련 스위치를 확장할 것).
// analyzer(analyzeForInStmt)/codegen(genForInStmt)은 C216이 구현 — 이터러블이 array/map으로
// 정적 판별될 때만 통과, 그 외(matrix/복합식 등)는 여전히 명시 거부(analyzer.ts
// resolveForInIterableKind 참조).
export interface ForInStmt extends Pos {
  kind: "ForInStmt";
  varName: string;
  indexName: string | null;
  iterable: Expr;
  body: Stmt[];
}

// IfStmt와 동일하게 값 위치(제어문-식)에서도 쓰인다 — 위 IfStmt 주석 참조.
export interface WhileStmt extends Pos {
  kind: "WhileStmt";
  condition: Expr;
  body: Stmt[];
}

export interface SwitchCase {
  values: Expr[] | null; // null = default 분기 (bare '=>')
  body: Stmt[];
}

// IfStmt와 동일하게 값 위치(제어문-식)에서도 쓰인다 — 위 IfStmt 주석 참조.
export interface SwitchStmt extends Pos {
  kind: "SwitchStmt";
  subject: Expr | null; // null이면 각 case가 그 자체로 boolean 조건
  cases: SwitchCase[];
}

export interface BreakStmt extends Pos {
  kind: "BreakStmt";
}

export interface ContinueStmt extends Pos {
  kind: "ContinueStmt";
}

// 함수 선언: name(params) => body (한 줄 표현식 또는 들여쓰기 블록).
// 암시 return(마지막 문장의 값)/slotBase 전파는 analyzer/codegen 담당(별도 ROADMAP 항목) — 이번은 파싱만.
export interface FuncParam extends Pos {
  kind: "FuncParam";
  name: string;
  typeHint: string | null;
  default: Expr | null;
}

export interface FuncDecl extends Pos {
  kind: "FuncDecl";
  name: string;
  params: FuncParam[];
  body: Stmt[];
}

// method 선언: `method name(params) => body` (FuncDecl과 동일한 파라미터/본문 문법 — 파서는
// parseParamsAndBody를 그대로 공유한다). 첫 파라미터의 typeHint가 이 method가 "확장하는" UDT
// 타입명이다(TV v5 실제 문법 — pine2py처럼 파라미터 이름/위치를 무시하지 않고 타입 힌트로 소속을
// 결정, analyzer.ts analyzeMethodDecl 참조). analyzer가 `TypeName$methodName`으로 mangled
// dispatch해 pine2py의 flat 함수 네임스페이스 동명 메서드 충돌 버그(LIMITATIONS.md 참조)를
// 따르지 않는다 — 호출은 `obj.methodName(args)` 점 호출 문법만 지원(bare methodName(args)나
// TypeName.methodName(obj,args) 형태는 이번 슬라이스 범위 밖).
export interface MethodDecl extends Pos {
  kind: "MethodDecl";
  name: string;
  params: FuncParam[];
  body: Stmt[];
}

// [a, b] = expr 튜플 언패킹.
export interface TupleDestructure extends Pos {
  kind: "TupleDestructure";
  names: string[];
  value: Expr;
}

export type Expr =
  | BinOp
  | UnaryOp
  | TernaryOp
  | CallExpr
  | DotAccess
  | IndexAccess
  | Identifier
  | NumberLiteral
  | StringLiteral
  | BoolLiteral
  | NaLiteral
  | ColorLiteral
  | TupleExpr
  | IfStmt
  | ForStmt
  | WhileStmt
  | SwitchStmt;

// series[n] — 히스토리 참조 연산자(postfix). 이번 슬라이스는 obj가 bar series(open/high/low/
// close/volume) 또는 top-level var/varip 식별자인 경우만 지원하고, index는 컴파일타임 정수
// 리터럴만 허용한다(동적 오프셋/array 인덱싱/'=' 로컬·UDF 내부 var 히스토리는 LIMITATIONS.md 참조).
// pine2py ast_nodes.py의 IndexAccess(obj, index)와 동일한 이름/모양으로 이식 — array 인덱싱(P2)도
// 나중에 이 같은 노드를 재사용할 예정이라 이름을 히스토리 전용으로 좁히지 않았다.
export interface IndexAccess extends Pos {
  kind: "IndexAccess";
  obj: Expr;
  index: Expr;
}

// [a, b, c] — UDF 함수 본문의 마지막 문장 값(튜플 반환)으로만 지원(analyzer가 다른 위치를 거부).
// LHS 튜플 destructure 타깃(`[a, b] = expr`)은 별도 AST(TupleDestructure)라 이 노드를 쓰지 않는다.
export interface TupleExpr extends Pos {
  kind: "TupleExpr";
  elements: Expr[];
}

export interface BinOp extends Pos {
  kind: "BinOp";
  op: "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "and" | "or";
  left: Expr;
  right: Expr;
}

export interface UnaryOp extends Pos {
  kind: "UnaryOp";
  op: "-" | "not";
  operand: Expr;
}

export interface TernaryOp extends Pos {
  kind: "TernaryOp";
  condition: Expr;
  trueExpr: Expr;
  falseExpr: Expr;
}

// 키워드 인자(`field=value`) 한 항목 — 현재는 UDT 생성자 호출(`TypeName.new(...)`, C129)에서만
// 의미가 있다(analyzer가 그 외 호출에서는 하드 에러로 거부). args(위치 인자)와 별도 배열로 둬
// 기존 args: Expr[]를 그대로 소비하는 다른 모든 호출 경로(UDF/method/빌트인)를 건드리지 않는다.
export interface CallKwarg extends Pos {
  name: string;
  value: Expr;
}

export interface CallExpr extends Pos {
  kind: "CallExpr";
  callee: Identifier | DotAccess;
  args: Expr[];
  kwargs: CallKwarg[];
}

export interface DotAccess extends Pos {
  kind: "DotAccess";
  obj: Expr;
  attr: string;
  // array.new<T>()의 T가 5종 원시 타입/drawing 타입 밖일 때(attr이 "new_generic"으로 재작성되는
  // 경우, parser.ts consumeArrayNewGenericTypeArg) 파서가 소비 도중 확인한 원 타입 식별자를 보존
  // (C355) -- attr 자신은 T와 무관하게 "new_generic" 하나로 뭉개지므로, analyzer가 T가 등록된 UDT
  // 이름인지 나중에 판별할 수 있도록 별도로 들고 다닌다. matrix.new<T>()(C618, attr은 "new" 그대로)와
  // map.new<K, V>()(C684, 값 타입 V만 — 키 K는 미보존)도 같은 필드를 재사용한다. 그 세 경우 밖에서는
  // 항상 undefined.
  genericElemType?: string;
}

export interface Identifier extends Pos {
  kind: "Identifier";
  name: string;
}

export interface NumberLiteral extends Pos {
  kind: "NumberLiteral";
  value: number;
  raw: string;
}

export interface StringLiteral extends Pos {
  kind: "StringLiteral";
  value: string;
}

export interface BoolLiteral extends Pos {
  kind: "BoolLiteral";
  value: boolean;
}

export interface NaLiteral extends Pos {
  kind: "NaLiteral";
}

// #RRGGBB / #RRGGBBAA 리터럴(lexer.ts readColor가 이미 COLOR 토큰으로 만들어두지만 parser가
// 소비하지 않아 전부 ParseError였다, C226). value는 lexer 토큰 값 그대로('#' 포함, 대소문자 보존)
// -- color는 GOAL.md na 3분할에서 string과 동일한 참조형(런타임 표현도 그냥 hex string, color.red
// 등 COLOR_CONSTANTS와 동일 표현)이라 codegen이 이 값을 그대로 JS 문자열 리터럴로 방출한다.
export interface ColorLiteral extends Pos {
  kind: "ColorLiteral";
  value: string;
}
