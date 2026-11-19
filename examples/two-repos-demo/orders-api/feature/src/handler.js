import { orderTotalCents } from './total.js';

// The answer to a request for one order. The total is in cents, and the answer names its currency.
export function getOrder(order) {
  return { id: order.id, totalCents: orderTotalCents(order), currency: order.currency };
}
