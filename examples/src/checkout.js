// Original source for the example bundle. `applyDiscount` throws for
// unknown codes — the error you will see minified in examples/logs/prod.log.
export function applyDiscount(cart, code) {
  const rule = RULES[code];
  if (!rule) {
    throw new Error(`unknown discount code: ${code}`);
  }
  return cart.items.map((item) => rule.apply(item));
}

export function computeTotal(cart, code) {
  const discounted = applyDiscount(cart, code);
  return discounted.reduce((sum, item) => sum + item.price, 0);
}

const RULES = {
  SPRING10: { apply: (item) => ({ ...item, price: item.price * 0.9 }) },
};
