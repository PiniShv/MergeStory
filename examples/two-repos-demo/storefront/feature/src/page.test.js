import assert from 'node:assert/strict';
import { test } from 'node:test';
import { totalLine } from './page.js';

test('the page shows the cents as a price', () => {
  assert.equal(totalLine({ id: 'o1', totalCents: 1250, currency: 'EUR' }), 'Total: 12.50 EUR');
});
