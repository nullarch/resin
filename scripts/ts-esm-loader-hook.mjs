// Node ESM customization hook that lets plain `node` execute src/ directly.
// It does two jobs:
//
// 1. resolve(): src/ uses extensionless relative imports (`./analyzer` etc.,
//    the tsconfig "moduleResolution": "Bundler" convention — vitest/tsc already
//    understand it). Node's ESM loader does no extension inference (and
//    analyzer.ts vs analyzer/ share a name), so without this hook a direct
//    import of src/ fails with ERR_MODULE_NOT_FOUND / ERR_UNSUPPORTED_DIR_IMPORT.
//
// 2. load(): strips the TypeScript types ourselves via node:module's
//    stripTypeScriptTypes(). Node's built-in type stripping refuses files under
//    node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is
//    exactly where this package lives for npm consumers — the CLI worked from
//    a clone but died after `npm install` until this hook took over the job.
//    Strip mode keeps line numbers intact and matches the constraint the repo
//    already lives under from clone-mode built-in stripping (no enums, no
//    namespaces, no parameter properties).
//
// Only node:module's register() hook API is used — no new npm dependencies
// (GOAL.md "no new dependencies" rule).
//
// Usage: at the top of an entry point,
//   import { register } from "node:module";
//   register("./ts-esm-loader-hook.mjs", import.meta.url);
//   const mod = await import("../src/whatever.ts");
// or for library consumers on plain Node: `node --import @nullarch/resin/register`.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

// stripTypeScriptTypes carries an ExperimentalWarning that would print on
// every CLI invocation. Mute exactly that warning, nothing else. (engines
// pins Node >=22.18 where the API's strip mode is stable in behavior.)
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  if (String(warning).includes("stripTypeScriptTypes")) return;
  return emitWarning.call(process, warning, ...args);
};

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

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { mode: "strip" }),
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
