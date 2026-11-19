// Adds up the lines of an order. Prices are stored in cents.
export function orderTotal(order) {
  return order.lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
}
