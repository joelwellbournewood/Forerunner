// Clamp a number into [lo, hi].
function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return lo;
  return x;
}

// Round to n decimals.
function round(x, n) {
  const f = Math.pow(10, n);
  return Math.round(x * f) / f;
}

module.exports = { clamp, round };
