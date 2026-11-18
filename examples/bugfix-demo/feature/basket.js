// Quantities come from the page as text, for example "2" and "3".
function basketCount(first, second) {
  return Number(first) + Number(second);
}

function itemsLabel(count) {
  return count + (count === 1 ? ' item' : ' items');
}

if (typeof document !== 'undefined') {
  const mix = document.getElementById('qty-mix');
  const bar = document.getElementById('qty-bar');
  const show = () => {
    document.getElementById('count').textContent = itemsLabel(basketCount(mix.value, bar.value));
  };
  mix.addEventListener('input', show);
  bar.addEventListener('input', show);
}

if (typeof module !== 'undefined') module.exports = { basketCount, itemsLabel };
