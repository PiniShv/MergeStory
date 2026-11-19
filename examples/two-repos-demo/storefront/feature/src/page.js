import { formatMoney } from './money.js';

// The line under the basket. The order comes from the orders service.
export function totalLine(order) {
  return `Total: ${formatMoney(order.totalCents, order.currency)}`;
}
