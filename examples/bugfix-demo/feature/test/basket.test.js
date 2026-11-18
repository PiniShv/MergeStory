const test = require('node:test');
const assert = require('node:assert');
const { basketCount, itemsLabel } = require('../basket.js');

test('adds quantities that arrive as text', () => {
  assert.strictEqual(basketCount('2', '3'), 5);
});

test('treats an empty field as zero', () => {
  assert.strictEqual(basketCount('', '4'), 4);
});

test('says item for one and items for the rest', () => {
  assert.strictEqual(itemsLabel(1), '1 item');
  assert.strictEqual(itemsLabel(5), '5 items');
});
