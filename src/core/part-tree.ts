/**
 * The parts between an anchor and a target in a list's order, inclusive, for Shift+click. The
 * anchor comes first, so it stays the primary part. Without an anchor in the list, the target
 * alone is chosen. A target of several parts, such as a group, is reached to its far end.
 */
export function selectionRange(
  order: string[],
  anchor: string | null | undefined,
  target: string[],
) {
  const at = target.map((id) => order.indexOf(id)).filter((index) => index >= 0);
  const from = anchor ? order.indexOf(anchor) : -1;
  if (!at.length || from < 0) return target;
  const low = Math.min(from, ...at),
    high = Math.max(from, ...at);
  const range = order.slice(low, high + 1);
  if (from === high) return range.reverse();
  return [order[from], ...range.filter((id) => id !== order[from])];
}
