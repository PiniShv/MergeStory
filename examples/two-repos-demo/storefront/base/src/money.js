// Shows an amount with two decimals and its currency.
export function formatMoney(amount, currency) {
  return `${amount.toFixed(2)} ${currency}`;
}
