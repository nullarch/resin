// Loader registration for plain-Node consumers (no bundler). The package ships
// TypeScript source; bundlers handle it natively, but bare `node` needs this
// hook to resolve extensionless imports and strip types under node_modules:
//
//   node --import @nullarch/resin/register your-script.mjs
//
// The CLI (`npx resin ...`) registers the same hook itself — this entry exists
// for library use only.
import { register } from "node:module";

register("./scripts/ts-esm-loader-hook.mjs", import.meta.url);
