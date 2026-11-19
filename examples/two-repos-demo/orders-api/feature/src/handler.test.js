import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOrder } from './handler.js';

test('the answer gives the total in cents and the currency', () => {
  const order = {
    id: 'o1',
    currency: 'EUR',
    lines: [
      { priceCents: 500, qty: 2 },
      { priceCents: 250, qty: 1 },
    ],
  };
  assert.deepEqual(getOrder(order), { id: 'o1', totalCents: 1250, currency: 'EUR' });
});
