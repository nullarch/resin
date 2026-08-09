// 위치 인자 vs 키워드 인자 "무해 중복" 판별 (배치33 (5), C561 재개방). TV 실측
// (scratch/tv_validation/results.jsonl, kwarg_dup 버킷 13건) 결과 8/13이 실제로 TV 컴파일을
// 통과했다 — 값 선택 시맨틱(위치/키워드 어느 쪽이 이기는지)은 미검증이라 보수 슬라이스로 좁힌다:
// 두 값이 구문상 완전히 동일하면(어느 쪽이 이기든 결과가 같으므로) 무해 중복으로 수용, 다르면
// 기존 에러를 유지한다. 실측 데이터 재확인(C654): TV accept 8건 전부 위치값==키워드값(리터럴/
// DotAccess 상수 동일 텍스트), TV reject 중 이 축 자체가 원인인 2건(656fc2756ab9/ff62b5038ab0)은
// 둘 다 값이 다름 — 이 가설과 정합.
import type { Expr } from "../ast";

export function exprsSyntacticallyEqual(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "Identifier":
      return a.name === (b as typeof a).name;
    case "NumberLiteral":
      return a.value === (b as typeof a).value;
    case "StringLiteral":
      return a.value === (b as typeof a).value;
    case "BoolLiteral":
      return a.value === (b as typeof a).value;
    case "ColorLiteral":
      return a.value === (b as typeof a).value;
    case "NaLiteral":
      return true;
    case "DotAccess": {
      const bb = b as typeof a;
      return a.attr === bb.attr && exprsSyntacticallyEqual(a.obj, bb.obj);
    }
    case "UnaryOp": {
      const bb = b as typeof a;
      return a.op === bb.op && exprsSyntacticallyEqual(a.operand, bb.operand);
    }
    case "BinOp": {
      const bb = b as typeof a;
      return a.op === bb.op && exprsSyntacticallyEqual(a.left, bb.left) && exprsSyntacticallyEqual(a.right, bb.right);
    }
    case "TernaryOp": {
      const bb = b as typeof a;
      return (
        exprsSyntacticallyEqual(a.condition, bb.condition) &&
        exprsSyntacticallyEqual(a.trueExpr, bb.trueExpr) &&
        exprsSyntacticallyEqual(a.falseExpr, bb.falseExpr)
      );
    }
    default:
      // CallExpr/IndexAccess/TupleExpr/제어문-식(IfStmt 등)은 부작용/상태/평가시점 차이가 있을 수
      // 있어 텍스트가 같아도 "값이 같다"고 단정하지 않는다(보수 슬라이스 원칙) — 항상 불일치 취급.
      return false;
  }
}

// posArg가 없거나(순수 키워드-키워드 중복) 구문상 다르면 기존 에러 유지, 같으면 무해 중복으로 수용.
export function isHarmlessArgDup(posArg: Expr | undefined, kwValue: Expr): boolean {
  return posArg !== undefined && exprsSyntacticallyEqual(posArg, kwValue);
}
