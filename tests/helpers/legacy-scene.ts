import { serializeGeometry } from '../../src/core/geometry';
import type { SceneDocument, SceneFile } from '../../src/core/types';

/** Writes the JSON format of earlier versions, which the app can still open. */
export function serializeScene(scene: SceneDocument): SceneFile {
  return {
    format: 'kitbasher',
    version: 1,
    units: 'mm',
    name: scene.name,
    parts: scene.parts.map((part) => ({ ...part, geometry: serializeGeometry(part.geometry) })),
    joints: scene.joints,
    constraints: scene.constraints ?? [],
  };
}
