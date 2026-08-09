// syminfo.ticker(symbol) — the one-argument call form, distinct from the bare
// `syminfo.ticker` property, which folds to "" at compile time.
//
// The reference implementation has no equivalent, so this is hand-verified
// rather than differentially tested, and the behaviour is inferred rather than
// confirmed against TradingView: from an "EXCHANGE:TICKER" string, return the
// part after the colon; with no colon, return the argument unchanged. A null
// (na) string propagates.
export function ticker(symbol: string | null): string | null {
  if (symbol === null) return null;
  const idx = symbol.indexOf(":");
  return idx === -1 ? symbol : symbol.slice(idx + 1);
}
