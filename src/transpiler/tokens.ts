// PineScript v5 토큰 타입 정의. pine2py/src/pine2wave/tokens.py 포팅.

export type TokenType =
  // Literals
  | "NUMBER"
  | "STRING"
  | "BOOL"
  | "COLOR"
  | "NA"
  // Identifiers & Keywords
  | "IDENTIFIER"
  | "INDICATOR"
  | "STRATEGY"
  | "LIBRARY"
  | "IF"
  | "ELSE"
  | "FOR"
  | "TO"
  | "BY"
  | "WHILE"
  | "SWITCH"
  | "VAR"
  | "VARIP"
  | "IMPORT"
  | "EXPORT"
  | "TYPE"
  | "METHOD"
  | "ENUM"
  | "BREAK"
  | "CONTINUE"
  | "SERIES"
  | "SIMPLE"
  | "CONST"
  // Operators
  | "ASSIGN"
  | "WALRUS"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "PERCENT"
  | "EQ"
  | "NEQ"
  | "LT"
  | "GT"
  | "LTE"
  | "GTE"
  | "AND"
  | "OR"
  | "NOT"
  | "QUESTION"
  | "COLON"
  | "FAT_ARROW"
  | "PLUS_ASSIGN"
  | "MINUS_ASSIGN"
  | "STAR_ASSIGN"
  | "SLASH_ASSIGN"
  | "PERCENT_ASSIGN"
  // Delimiters
  | "LPAREN"
  | "RPAREN"
  | "LBRACKET"
  | "RBRACKET"
  | "COMMA"
  | "DOT"
  // Structure
  | "NEWLINE"
  | "INDENT"
  | "DEDENT"
  | "EOF"
  // Special
  | "COMMENT"
  | "ANNOTATION"
  | "ARROW";

export const KEYWORDS: Readonly<Record<string, TokenType>> = {
  indicator: "INDICATOR",
  strategy: "STRATEGY",
  library: "LIBRARY",
  if: "IF",
  else: "ELSE",
  for: "FOR",
  to: "TO",
  by: "BY",
  while: "WHILE",
  switch: "SWITCH",
  var: "VAR",
  varip: "VARIP",
  import: "IMPORT",
  export: "EXPORT",
  type: "TYPE",
  method: "METHOD",
  enum: "ENUM",
  series: "SERIES",
  simple: "SIMPLE",
  const: "CONST",
  true: "BOOL",
  false: "BOOL",
  na: "NA",
  and: "AND",
  or: "OR",
  not: "NOT",
  break: "BREAK",
  continue: "CONTINUE",
};

export const TWO_CHAR_OPS: Readonly<Record<string, TokenType>> = {
  "==": "EQ",
  "!=": "NEQ",
  "<=": "LTE",
  ">=": "GTE",
  ":=": "WALRUS",
  "=>": "FAT_ARROW",
  "+=": "PLUS_ASSIGN",
  "-=": "MINUS_ASSIGN",
  "*=": "STAR_ASSIGN",
  "/=": "SLASH_ASSIGN",
  "%=": "PERCENT_ASSIGN",
  "->": "ARROW",
};

export const ONE_CHAR_OPS: Readonly<Record<string, TokenType>> = {
  "=": "ASSIGN",
  "+": "PLUS",
  "-": "MINUS",
  "*": "STAR",
  "/": "SLASH",
  "%": "PERCENT",
  "<": "LT",
  ">": "GT",
  "(": "LPAREN",
  ")": "RPAREN",
  "[": "LBRACKET",
  "]": "RBRACKET",
  ",": "COMMA",
  ".": "DOT",
  "?": "QUESTION",
  ":": "COLON",
};

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}
