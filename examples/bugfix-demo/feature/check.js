// Prints what the basket shows for two typed quantities. The lines never change between runs.
const { basketCount, itemsLabel } = require('./basket.js');

for (const [first, second] of [
  ['2', '3'],
  ['10', '4'],
]) {
  console.log(`typed ${first} and ${second}`);
  console.log(`  joined as text, the old way: ${first + second}`);
  console.log(`  added as numbers: ${itemsLabel(basketCount(first, second))}`);
}
console.log('done');
