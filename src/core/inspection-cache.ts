import { geometryKey } from './geometry-transfer';
import type { InspectionResult } from './inspection-types';
import type { Part } from './types';

/** Snapshot values, not mutable Part references, before handing work to a worker. */
export function inspectionInput(parts: Part[], distance: number) {
  return {
    distance,
    parts: new Map(
      parts.map((part) => [
        part.id,
        JSON.stringify([
          geometryKey(part.geometry),
          part.name,
          part.position,
          part.quaternion,
          part.scale,
        ]),
      ]),
    ),
  };
}

type InspectionInput = ReturnType<typeof inspectionInput>;

function covers(cached: InspectionInput, requested: InspectionInput) {
  return (
    cached.distance === requested.distance &&
    [...requested.parts].every(([id, key]) => cached.parts.get(id) === key)
  );
}

export function scopeInspection(result: InspectionResult, ids: Set<string>): InspectionResult {
  const includesPair = (pair: { a: string; b: string }) => ids.has(pair.a) && ids.has(pair.b);
  const pairs = result.pairs.filter(includesPair);
  const solidParts = result.solidParts.filter((id) => ids.has(id));
  const closed = new Set(solidParts);
  const failedSolids = pairs.filter(
    (pair) => pair.volume === null && closed.has(pair.a) && closed.has(pair.b),
  ).length;
  return {
    ...result,
    pairs,
    overlaps: result.overlaps.filter(includesPair),
    surfaces: result.surfaces.filter((surface) => ids.has(surface.id) && ids.has(surface.otherId)),
    solidParts,
    checkedPairs: (ids.size * (ids.size - 1)) / 2,
    solidPairs: (solidParts.length * (solidParts.length - 1)) / 2 - failedSolids,
    warnings: result.warnings.filter((warning) => warning.partIds.every((id) => ids.has(id))),
  };
}

/** Keep reusable results without retaining source meshes or unbounded overlay buffers. */
export class InspectionCache {
  private entries: { input: InspectionInput; result: InspectionResult; bytes: number }[] = [];

  get(input: InspectionInput): InspectionResult | null {
    const entry = this.entries.find((entry) => covers(entry.input, input));
    if (!entry) return null;
    return entry.input.parts.size === input.parts.size
      ? entry.result
      : scopeInspection(entry.result, new Set(input.parts.keys()));
  }

  set(input: InspectionInput, result: InspectionResult) {
    // A wider result replaces any narrower results it already covers.
    this.entries = this.entries.filter((entry) => !covers(input, entry.input));
    this.entries.unshift({
      input,
      result,
      bytes: [...result.overlaps, ...result.surfaces].reduce(
        (sum, surface) => sum + surface.positions.byteLength,
        0,
      ),
    });
    let bytes = 0;
    this.entries = this.entries.filter((entry, index) => {
      bytes += entry.bytes;
      // Always retain the latest result, even if a single dense scan exceeds the budget.
      return index === 0 || (index < 4 && bytes <= 64 * 1024 * 1024);
    });
  }
}
