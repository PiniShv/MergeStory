import { orderTotal } from './total.js';

// The answer to a request for one order.
export function getOrder(order) {
  return { id: order.id, total: orderTotal(order) };
}
