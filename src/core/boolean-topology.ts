import type { BufferGeometry } from 'three';
import { Brush, HalfEdgeMap } from 'three-bvh-csg';
import { weldedPositionIndex } from './mesh-topology';

/** The installed CSG declarations omit these public runtime fields. */
export class NumericHalfEdgeMap extends HalfEdgeMap {
  declare data: Int32Array | null;
  declare useAllAttributes: boolean;
  declare matchDisjointEdges: boolean;
  declare matchedEdges: number;
  declare unmatchedEdges: number;

  override updateFrom(geometry: BufferGeometry) {
    if (
      this.useAllAttributes ||
      this.matchDisjointEdges ||
      geometry.drawRange.start !== 0 ||
      geometry.drawRange.count !== Infinity
    )
      return super.updateFrom(geometry);
    const { indices, vertices } = weldedPositionIndex(geometry, 'csg');
    if (!Number.isSafeInteger(vertices * vertices)) return super.updateFrom(geometry);
    const data =
      this.data && this.data.length >= indices.length ? this.data : new Int32Array(indices.length);
    data.fill(-1);
    const edges = new Map<number, number>();
    const unmatched = new Set<number>();
    let matched = 0;
    for (let i = 0; i < indices.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = indices[i + e],
          b = indices[i + ((e + 1) % 3)];
        const reverse = b * vertices + a;
        const other = edges.get(reverse);
        if (other !== undefined) {
          data[i + e] = other;
          data[other] = i + e;
          edges.delete(reverse);
          unmatched.delete(other);
          matched += 2;
        } else {
          edges.set(a * vertices + b, i + e);
          unmatched.add(i + e);
        }
      }
    }
    this.data = data;
    this.matchedEdges = matched;
    this.unmatchedEdges = unmatched.size;
  }
}

export class PreparedBrush extends Brush {
  override prepareGeometry() {
    const geometry = this.geometry as BufferGeometry & { halfEdges?: HalfEdgeMap };
    geometry.halfEdges ??= new NumericHalfEdgeMap();
    super.prepareGeometry();
  }
}
