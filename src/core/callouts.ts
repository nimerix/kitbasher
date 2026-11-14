import type { CalloutPlacement } from './preferences';

export interface CalloutBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface CalloutPoint {
  x: number;
  y: number;
}

export interface CalloutItem extends CalloutPoint {
  /** Label size in screen pixels. */
  width: number;
  height: number;
  /** Marker radius, so the leader starts at its edge. */
  radius: number;
  /** Projected visible model bounds; these can extend outside the viewport. */
  modelBounds: CalloutBounds | null;
}

export interface CalloutSettings {
  placement: CalloutPlacement;
  clearance: number;
  leader: number;
}

export interface PlacedCallout extends CalloutPoint {
  /** Marker edge, elbow, and horizontal landing beside the label. */
  leader: [CalloutPoint, CalloutPoint, CalloutPoint] | null;
}

interface Route extends PlacedCallout {
  leader: NonNullable<PlacedCallout['leader']>;
  bounds: CalloutBounds;
  obstruction: number;
  cost: number;
}

const gap = 3;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const expand = (r: CalloutBounds, x: number, y = x): CalloutBounds => ({
  left: r.left - x,
  right: r.right + x,
  top: r.top - y,
  bottom: r.bottom + y,
});
const contains = (r: CalloutBounds, p: CalloutPoint) =>
  p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
const overlaps = (a: CalloutBounds, b: CalloutBounds) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Clip a segment against a rectangle, including its border. */
function hitsBox(a: CalloutPoint, b: CalloutPoint, box: CalloutBounds) {
  let enter = 0,
    leave = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, box.left, box.right],
    [a.y, b.y - a.y, box.top, box.bottom],
  ]) {
    if (Math.abs(delta) < 1e-8) {
      if (start < min || start > max) return false;
    } else {
      const first = (min - start) / delta,
        last = (max - start) / delta;
      enter = Math.max(enter, Math.min(first, last));
      leave = Math.min(leave, Math.max(first, last));
      if (enter > leave) return false;
    }
  }
  return true;
}

function pointDistance(p: CalloutPoint, a: CalloutPoint, b: CalloutPoint) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Includes collinear overlap and nearly touching leaders, not just crossings. */
function linesConflict(a: CalloutPoint, b: CalloutPoint, c: CalloutPoint, d: CalloutPoint) {
  const cross = (p: CalloutPoint, q: CalloutPoint, r: CalloutPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
  return (
    Math.min(
      pointDistance(a, c, d),
      pointDistance(b, c, d),
      pointDistance(c, a, b),
      pointDistance(d, a, b),
    ) < gap
  );
}

function conflicts(a: Route, b: Route) {
  let count = overlaps(expand(a.bounds, gap), b.bounds) ? 12 : 0;
  for (let i = 0; i < 2; i++) {
    if (hitsBox(a.leader[i], a.leader[i + 1], expand(b.bounds, gap))) count += 8;
    if (hitsBox(b.leader[i], b.leader[i + 1], expand(a.bounds, gap))) count += 8;
    for (let j = 0; j < 2; j++)
      if (linesConflict(a.leader[i], a.leader[i + 1], b.leader[j], b.leader[j + 1])) count += 2;
  }
  return count;
}

/**
 * Search independent routes around each point. Both arms can change length and direction
 * to clear the model, labels, and other leaders; no shared row or column is imposed.
 */
export function layoutCallouts(
  items: CalloutItem[],
  settings: CalloutSettings,
  viewport: { width: number; height: number },
  margin = 8,
): PlacedCallout[] {
  const reach = Math.max(12, settings.leader);
  const clearance = settings.placement === 'model' ? settings.clearance : gap;
  const candidates = items.map((item) => {
    const halfWidth = item.width / 2,
      halfHeight = item.height / 2;
    const model = item.modelBounds && expand(item.modelBounds, clearance);
    // The whole landing and label must clear the model, including the label's height.
    const outline = model && expand(model, 1, halfHeight + 1);
    const routes: Route[] = [];
    const seen = new Set<string>();
    for (const side of [1, -1]) {
      for (const vertical of [-1, 1]) {
        for (const slope of [2, 1, 0.5]) {
          const ux = side / Math.hypot(1, slope),
            uy = (vertical * slope) / Math.hypot(1, slope);
          let distance = item.radius + reach;
          if (outline && contains(outline, item)) {
            const exit = Math.min(
              ((side > 0 ? outline.right : outline.left) - item.x) / ux,
              ((vertical > 0 ? outline.bottom : outline.top) - item.y) / uy,
            );
            distance = Math.max(distance, exit);
          }
          // Local routes are a fallback when a zoomed model fills the viewport.
          const distances =
            distance > item.radius + reach ? [distance, item.radius + reach] : [distance];
          for (const base of distances) {
            for (const row of [0, 1, 2, 4]) {
              const length = base + (row * (item.height + gap * 2)) / Math.abs(uy);
              const preferredLanding = clamp(length * 0.4, 24, 80);
              for (const landing of [preferredLanding, 12, preferredLanding * 1.5]) {
                const y = clamp(
                  item.y + uy * length,
                  margin + halfHeight,
                  viewport.height - margin - halfHeight,
                );
                const x = clamp(
                  item.x + ux * length + side * (landing + gap + halfWidth),
                  margin + halfWidth,
                  viewport.width - margin - halfWidth,
                );
                const end = { x: x - side * (halfWidth + gap), y };
                const elbow = { x: end.x - side * landing, y };
                const dx = elbow.x - item.x,
                  dy = elbow.y - item.y,
                  arm = Math.hypot(dx, dy);
                if (side * dx < 6 || Math.abs(dy) < 8 || arm <= item.radius + 1) continue;
                const key = `${x.toFixed(2)},${y.toFixed(2)},${elbow.x.toFixed(2)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const start = {
                  x: item.x + (dx * item.radius) / arm,
                  y: item.y + (dy * item.radius) / arm,
                };
                const bounds = {
                  left: x - halfWidth,
                  right: x + halfWidth,
                  top: y - halfHeight,
                  bottom: y + halfHeight,
                };
                let obstruction = 0;
                if (model) {
                  if (overlaps(bounds, model)) obstruction += 4;
                  if (hitsBox(elbow, end, model)) obstruction += 4;
                  if (!contains(model, item) && hitsBox(start, elbow, model)) obstruction += 2;
                }
                for (const other of items) {
                  if (other === item) continue;
                  if (contains(expand(bounds, other.radius + gap), other)) obstruction += 8;
                  if (
                    pointDistance(other, start, elbow) < other.radius + gap ||
                    pointDistance(other, elbow, end) < other.radius + gap
                  )
                    obstruction += 2;
                }
                routes.push({
                  x,
                  y,
                  leader: [start, elbow, end],
                  bounds,
                  obstruction,
                  cost:
                    (settings.placement === 'offset' ? Math.abs(arm - item.radius - reach) : arm) +
                    Math.abs(landing - preferredLanding) * 0.4 +
                    landing * 0.15 +
                    Math.abs(Math.atan2(Math.abs(dy), Math.abs(dx)) - Math.atan(2)) * 12 +
                    (side < 0 ? 4 : 0) +
                    (dy > 0 ? 10 : 0),
                });
              }
            }
          }
        }
      }
    }
    return routes.sort((a, b) => a.obstruction - b.obstruction || a.cost - b.cost);
  });
  const placed: (Route | undefined)[] = new Array(items.length);
  const obstruction = (route: Route, index: number) =>
    placed.reduce(
      (sum, other, i) => sum + (other && i !== index ? conflicts(route, other) : 0),
      route.obstruction,
    );
  const bestRoute = (index: number) => {
    let best: Route | undefined,
      bestObstruction = Infinity;
    for (const route of candidates[index]) {
      if (route.obstruction > bestObstruction) break;
      const count = obstruction(route, index);
      if (count < bestObstruction || (count === bestObstruction && route.cost < best!.cost)) {
        best = route;
        bestObstruction = count;
      }
      if (count === 0) break;
    }
    return best;
  };
  // Route the shortest exits first, so outer points do not get trapped behind inner ones.
  const order = candidates
    .map((routes, index) => ({ index, choices: routes.filter((r) => r.obstruction === 0).length }))
    .sort(
      (a, b) =>
        (candidates[a.index][0]?.cost ?? Infinity) - (candidates[b.index][0]?.cost ?? Infinity) ||
        a.choices - b.choices ||
        items[a.index].y - items[b.index].y ||
        items[a.index].x - items[b.index].x,
    );
  for (const { index } of order) placed[index] = bestRoute(index);
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const { index } of order) {
      const current = placed[index];
      if (!current || obstruction(current, index) === 0) continue;
      const next = bestRoute(index);
      if (next && next !== current && obstruction(next, index) < obstruction(current, index)) {
        placed[index] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return placed.map((route, index) =>
    route
      ? { x: route.x, y: route.y, leader: route.leader }
      : {
          x: clamp(
            items[index].x,
            margin + items[index].width / 2,
            viewport.width - margin - items[index].width / 2,
          ),
          y: clamp(
            items[index].y,
            margin + items[index].height / 2,
            viewport.height - margin - items[index].height / 2,
          ),
          leader: null,
        },
  );
}
