import type { CalloutPlacement } from './preferences';

export interface CalloutItem {
  /** The point on screen, in pixels from the viewport's top left. */
  x: number;
  y: number;
  /** Label size in pixels. */
  width: number;
  height: number;
  /** How far the point's marker extends, so the leader stops at its edge. */
  radius: number;
  /** The top of the point's part on screen, or null when it is unknown. */
  modelTop: number | null;
}

export interface CalloutSettings {
  placement: CalloutPlacement;
  clearance: number;
  leader: number;
}

export interface PlacedCallout {
  /** Label center. Always the point's x, so the leader stays vertical on screen. */
  x: number;
  y: number;
  /** Vertical leader from y1 to y2 at x, or null when the label touches the point. */
  leader: [number, number] | null;
}

/** The shortest leader, so a label never sits on its own point. */
const minimumLeader = 12;
const gap = 3;

/**
 * Places each label straight above its point, clear of the part's outline or at a fixed
 * leader length, then stacks overlapping labels away from the model.
 */
export function layoutCallouts(
  items: CalloutItem[],
  settings: CalloutSettings,
  viewport: { width: number; height: number },
  margin = 8,
): PlacedCallout[] {
  const placed = items.map((item) => {
    const half = item.height / 2;
    const reach = Math.max(
      minimumLeader,
      settings.placement === 'offset' ? settings.leader : minimumLeader,
    );
    let y =
      settings.placement === 'model' && item.modelTop !== null
        ? Math.min(item.modelTop - settings.clearance, item.y - item.radius - reach) - half
        : item.y - item.radius - reach - half;
    let above = true;
    if (y - half < margin) {
      y = margin + half;
      // Pinned to the top edge over the point itself, so hang the label below instead.
      if (y + half > item.y - item.radius - gap) {
        above = false;
        y = Math.min(item.y + item.radius + reach + half, viewport.height - margin - half);
      }
    }
    return { item, x: item.x, y, above };
  });
  const rects: { left: number; right: number; top: number; bottom: number }[] = [];
  const overlap = (left: number, right: number, top: number, bottom: number) =>
    rects.find(
      (r) =>
        left < r.right + gap &&
        right > r.left - gap &&
        top < r.bottom + gap &&
        bottom > r.top - gap,
    );
  // Labels nearest the model claim their place first, and later ones stack outward.
  const order = placed
    .map((label, index) => ({ label, index }))
    .sort((a, b) =>
      a.label.above === b.label.above
        ? a.label.above
          ? b.label.y - a.label.y
          : a.label.y - b.label.y
        : a.label.above
          ? -1
          : 1,
    );
  for (const { label } of order) {
    const halfWidth = label.item.width / 2,
      half = label.item.height / 2;
    for (let attempt = 0; attempt < items.length; attempt++) {
      const hit = overlap(label.x - halfWidth, label.x + halfWidth, label.y - half, label.y + half);
      if (!hit) break;
      label.y = label.above ? hit.top - gap - half : hit.bottom + gap + half;
    }
    rects.push({
      left: label.x - halfWidth,
      right: label.x + halfWidth,
      top: label.y - half,
      bottom: label.y + half,
    });
  }
  return placed.map(({ item, x, y }) => {
    const half = item.height / 2;
    const [y1, y2] =
      y < item.y ? [y + half, item.y - item.radius] : [item.y + item.radius, y - half];
    return { x, y, leader: y2 - y1 > 1 ? [y1, y2] : null };
  });
}
