// The chart symbol's price grid. resin runs every script against one fixed symbol environment:
// the analyzer folds syminfo.mintick/minmove/pricescale to these values, and the strategy engine
// measures tick distances (strategy.exit profit/loss/trail_points/trail_offset) on the same grid.
// mintick = minmove / pricescale.
export const MINMOVE = 1;
export const PRICESCALE = 100;
export const MINTICK = 0.01;

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
