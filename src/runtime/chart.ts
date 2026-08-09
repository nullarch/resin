// chart.is_standard and friends.
//
// This is a batch replay engine: it never applies a heikin-ashi, renko, kagi,
// line-break, point-and-figure or range transform to the bars it is given, for
// the same reason the ticker.* constructors reduce to string pass-throughs.
// The loaded symbol is therefore always a standard chart, which makes
// is_standard true and every other chart.is_* false the only coherent answer.
// Hand-verified; there is no reference implementation to compare against.

export function is_standard(): boolean {
  return true;
}

export function is_heikinashi(): boolean {
  return false;
}

export function is_renko(): boolean {
  return false;
}

export function is_kagi(): boolean {
  return false;
}

export function is_linebreak(): boolean {
  return false;
}

export function is_pnf(): boolean {
  return false;
}

export function is_range(): boolean {
  return false;
}
