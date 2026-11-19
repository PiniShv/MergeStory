// Shows an amount that is given in cents, with two decimals and its currency.
export function formatMoney(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
