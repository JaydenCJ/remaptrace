// Entry point of the example app: handles a checkout request.
import { computeTotal } from "./checkout.js";

export function handleCheckout(req) {
  const total = computeTotal(req.cart, req.code);
  return { ok: true, total };
}
