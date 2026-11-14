/** Screen-space callouts deliberately know nothing about the model's bounds. */
export interface CalloutBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CalloutOffset {
  x: number;
  y: number;
}

export interface CalloutItem extends CalloutOffset {
  id: string;
  width: number;
  height: number;
  radius: number;
}

export interface CalloutSettings {
  leader: number;
}

export interface PlacedCallout extends CalloutOffset {
  /** Intended local offset, before viewport clamping, for the next frame. */
  offset: CalloutOffset;
  /** A short, direct connector from the marker rim to the badge edge. */
  leader: [CalloutOffset, CalloutOffset] | null;
}

const margin = 8;
const gap = 5;
const clamp = (n: number, min: number, max: number) =>
  max < min ? (min + max) / 2 : Math.max(min, Math.min(max, n));
const bounds = (item: CalloutItem, p: CalloutOffset, padding = 0): CalloutBounds => ({
  left: p.x - item.width / 2 - padding,
  right: p.x + item.width / 2 + padding,
  top: p.y - item.height / 2 - padding,
  bottom: p.y + item.height / 2 + padding,
});
const overlap = (a: CalloutBounds, b: CalloutBounds) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

export function clampCallout(
  item: CalloutItem,
  center: CalloutOffset,
  viewport: { width: number; height: number },
): CalloutOffset {
  return {
    x: clamp(center.x, margin + item.width / 2, viewport.width - margin - item.width / 2),
    y: clamp(center.y, margin + item.height / 2, viewport.height - margin - item.height / 2),
  };
}

export function calloutLeader(item: CalloutItem, center: CalloutOffset): PlacedCallout['leader'] {
  const dx = center.x - item.x,
    dy = center.y - item.y;
  const distance = Math.hypot(dx, dy);
  // Intersect the ray toward the point with the badge's rectangular edge.
  const t = Math.min(item.width / 2 / Math.abs(dx), item.height / 2 / Math.abs(dy));
  if (!Number.isFinite(t) || t >= 1 || distance * (1 - t) <= item.radius + 2) return null;
  return [
    {
      x: item.x + (dx * (item.radius + 1)) / distance,
      y: item.y + (dy * (item.radius + 1)) / distance,
    },
    { x: center.x - dx * t, y: center.y - dy * t },
  ];
}

function hitsBox(line: NonNullable<PlacedCallout['leader']>, box: CalloutBounds) {
  let enter = 0,
    leave = 1;
  for (const [start, delta, min, max] of [
    [line[0].x, line[1].x - line[0].x, box.left, box.right],
    [line[0].y, line[1].y - line[0].y, box.top, box.bottom],
  ]) {
    if (Math.abs(delta) < 1e-8) {
      if (start < min || start > max) return false;
    } else {
      const a = (min - start) / delta,
        b = (max - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) return false;
    }
  }
  return true;
}

/**
 * Keep each label in a small neighborhood of its own point. Prior offsets are keyed
 * by identity, not screen order, and win unless a real obstruction needs resolving.
 * The local search is bounded even when no collision-free arrangement exists.
 */
export function layoutCallouts(
  items: CalloutItem[],
  settings: CalloutSettings,
  viewport: { width: number; height: number },
  previous: ReadonlyMap<string, CalloutOffset> = new Map(),
  obstacles: CalloutBounds[] = [],
): PlacedCallout[] {
  const reach = clamp(settings.leader, 16, 48);
  const directions = [
    [1, -1],
    [-1, -1],
    [1, 1],
    [-1, 1],
    [1, 0],
    [-1, 0],
    [0, -1],
    [0, 1],
  ];
  const candidates = items.map((item) => {
    const offsets: CalloutOffset[] = [];
    const prior = previous.get(item.id);
    if (prior) offsets.push(prior);
    for (const extra of [0, 16, 32])
      for (const [dx, dy] of directions) {
        const distance = item.radius + reach + extra;
        const diagonal = dx && dy ? Math.SQRT1_2 : 1;
        offsets.push({
          x: dx * (item.width / 2 + distance * diagonal),
          y: dy * (item.height / 2 + distance * diagonal),
        });
      }
    return offsets.map((offset, rank) => {
      const center = clampCallout(item, { x: item.x + offset.x, y: item.y + offset.y }, viewport);
      const leader = calloutLeader(item, center);
      const box = bounds(item, center);
      // A settings change cannot preserve an old, excessively long route.
      const length = leader ? Math.hypot(leader[1].x - leader[0].x, leader[1].y - leader[0].y) : 0;
      const movement = prior ? Math.hypot(offset.x - prior.x, offset.y - prior.y) : 0;
      let cost = length * 0.3 + rank * 0.15 + movement * 0.6;
      if (length > reach + 34) cost += 100000;
      if (!leader) cost += 10000;
      for (const obstacle of obstacles) {
        cost += overlap(bounds(item, center, gap), obstacle) * 100;
        if (leader && hitsBox(leader, obstacle)) cost += 30;
      }
      for (const point of items) {
        const r = point.radius + gap;
        cost +=
          overlap(box, {
            left: point.x - r,
            right: point.x + r,
            top: point.y - r,
            bottom: point.y + r,
          }) * 30;
      }
      return { ...center, offset, leader, cost, box };
    });
  });
  const chosen = candidates.map((routes) => routes[0]);
  // Existing labels get first refusal; creation/reordering must not reshuffle neighbors.
  const order = items
    .map((_, i) => i)
    .sort(
      (a, b) =>
        Number(previous.has(items[b].id)) - Number(previous.has(items[a].id)) ||
        items[a].id.localeCompare(items[b].id),
    );
  const routed = new Set(items.flatMap((item, i) => (previous.has(item.id) ? [i] : [])));
  for (let pass = 0; pass < 2; pass++) {
    for (const index of order) {
      const score = (route: (typeof chosen)[number]) => {
        let cost = route.cost;
        chosen.forEach((other, i) => {
          if (i === index || !routed.has(i)) return;
          cost += overlap(bounds(items[index], route, gap), other.box) * 100;
          if (route.leader && hitsBox(route.leader, other.box)) cost += 40;
          if (other.leader && hitsBox(other.leader, route.box)) cost += 40;
        });
        return cost;
      };
      let best = chosen[index],
        bestCost = score(best);
      for (const route of candidates[index]) {
        const cost = score(route);
        // A dead band prevents near-ties from changing direction as the camera moves.
        if (cost + 8 < bestCost) {
          best = route;
          bestCost = cost;
        }
      }
      chosen[index] = best;
      routed.add(index);
    }
  }
  return chosen.map(({ x, y, offset, leader }) => ({ x, y, offset, leader }));
}
