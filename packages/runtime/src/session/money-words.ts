/**
 * One money rule for what a person reads (W14-6, polish-words; design §5 rule 7): an amount above
 * zero never reads "CHF 0.00", which beside a budget with no room read as a contradiction
 * ("Stopped at the project's budget of CHF 0.01. CHF 0.00."); below a centime it is "less than
 * CHF 0.01". Nothing spent stays "CHF 0.00". `formatted` is the amount as the caller words it
 * ("CHF 0.00"), `amount` the same amount in micro units of any currency.
 */
export function moneyWords(formatted: string, amount: number): string {
  return amount > 0 && /^CHF 0\.00$/.test(formatted.trim()) ? "less than CHF 0.01" : formatted;
}

/** The same at the start of a sentence: "Less than CHF 0.01." */
export function moneyWordsFirst(formatted: string, amount: number): string {
  const w = moneyWords(formatted, amount);
  return w.charAt(0).toUpperCase() + w.slice(1);
}
