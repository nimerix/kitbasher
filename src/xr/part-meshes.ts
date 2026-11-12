import type { Mesh } from 'three';

/** The mesh the viewport draws for each part, for input that does not arrive through the canvas. */
export const partMeshes = new Map<string, Mesh>();
