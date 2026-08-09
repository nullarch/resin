// Node ESM 커스터마이징 훅: 확장자 없는 상대 import(`./analyzer` 등, tsconfig
// "moduleResolution": "Bundler" 관례 -- vitest/tsc는 이미 지원)를 순수 node 실행에서도
// 해석하기 위한 리졸버. src/transpiler는 번들러 없이 vitest(Vite)/tsc로만 소비돼 왔고
// Node ESM 로더는 확장자 자동 추론을 하지 않아(및 analyzer.ts 파일 vs analyzer/ 디렉토리
// 동명 충돌까지 겹쳐) `node scripts/*.mjs`가 src/를 직접 import하면 그대로 실패한다
// (ERR_MODULE_NOT_FOUND / ERR_UNSUPPORTED_DIR_IMPORT). node:module의 register() 커스텀
// 훅 API만 사용 -- 새 npm 의존성 없음(GOAL.md "새 의존성 추가 금지" 준수).
//
// 사용법: scripts/*.mjs 최상단에서
//   import { register } from "node:module";
//   register("./ts-esm-loader-hook.mjs", import.meta.url);
//   const mod = await import("../src/whatever.ts");
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HAS_EXT = /\.[a-zA-Z0-9]+$/;

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (isRelative && !HAS_EXT.test(specifier)) {
    const base = new URL(context.parentURL);
    for (const suffix of [".ts", "/index.ts"]) {
      const candidate = new URL(specifier + suffix, base);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(specifier + suffix, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
