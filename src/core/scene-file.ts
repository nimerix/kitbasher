import { binaryGeometry, deserializeGeometry, serializeGeometry } from './geometry';
import { validateJoint } from './constraints';
import { validatePlaneConstraints } from './plane-constraints';
import type { Joint, Part, PlaneConstraint, SceneDocument, SceneFile } from './types';

const sceneHeader = (scene: SceneDocument) =>
  ({
    format: 'kitbasher',
    version: 1,
    units: 'mm',
    name: scene.name,
    joints: scene.joints,
    constraints: scene.constraints ?? [],
  }) as const;

export function serializeScene(scene: SceneDocument): SceneFile {
  return {
    ...sceneHeader(scene),
    parts: scene.parts.map((p) => ({ ...p, geometry: serializeGeometry(p.geometry) })),
  };
}

/** Autosave runs after every edit, so it stores typed arrays instead of number lists. */
export function serializeRecovery(scene: SceneDocument) {
  return {
    ...sceneHeader(scene),
    parts: scene.parts.map((p) => ({ ...p, geometry: binaryGeometry(p.geometry) })),
  };
}

/** Relationships to excluded parts would make the resulting scene file invalid. */
export function sceneSubset(scene: SceneDocument, parts: Part[]): SceneDocument {
  const ids = new Set(parts.map((part) => part.id));
  return {
    ...scene,
    parts,
    joints: scene.joints.filter((j) => ids.has(j.parentId) && ids.has(j.childId)),
    constraints: scene.constraints?.filter((c) => ids.has(c.sourceId) && ids.has(c.targetId)),
  };
}

function finiteTuple(value: unknown, size: number): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(Number.isFinite);
}

export function parseScene(value: unknown): SceneDocument {
  const data = value as SceneFile;
  if (
    !data ||
    data.format !== 'kitbasher' ||
    data.version !== 1 ||
    data.units !== 'mm' ||
    !Array.isArray(data.parts) ||
    !Array.isArray(data.joints) ||
    typeof data.name !== 'string'
  ) {
    throw new Error('This is not a supported Kitbasher scene.');
  }
  const ids = new Set<string>();
  const parts = data.parts.map((p) => {
    if (
      !p ||
      typeof p.id !== 'string' ||
      ids.has(p.id) ||
      typeof p.name !== 'string' ||
      !finiteTuple(p.position, 3) ||
      !finiteTuple(p.quaternion, 4) ||
      !finiteTuple(p.scale, 3) ||
      (p.pivot !== undefined && !finiteTuple(p.pivot, 3)) ||
      p.scale.some((n) => Math.abs(n) < 1e-6) ||
      Math.abs(Math.hypot(...p.quaternion) - 1) > 0.01 ||
      typeof p.color !== 'string' ||
      !/^#[\da-f]{6}$/i.test(p.color) ||
      typeof p.visible !== 'boolean' ||
      typeof p.locked !== 'boolean'
    ) {
      throw new Error('The scene contains invalid part data.');
    }
    ids.add(p.id);
    return {
      ...p,
      source: typeof p.source === 'string' ? p.source : 'Scene',
      geometry: deserializeGeometry(p.geometry),
    };
  });
  const jointIds = new Set<string>(),
    joints: Joint[] = [];
  for (const j of data.joints) {
    if (
      !j ||
      typeof j.id !== 'string' ||
      jointIds.has(j.id) ||
      typeof j.name !== 'string' ||
      !ids.has(j.parentId) ||
      !ids.has(j.childId) ||
      !finiteTuple(j.parentAnchor, 3) ||
      !finiteTuple(j.childAnchor, 3) ||
      !finiteTuple(j.restRotation, 4) ||
      Math.abs(Math.hypot(...j.restRotation) - 1) > 0.01 ||
      !Array.isArray(j.rotationLocks) ||
      j.rotationLocks.length !== 3 ||
      !j.rotationLocks.every((b) => typeof b === 'boolean') ||
      (j.keepConnected !== undefined && typeof j.keepConnected !== 'boolean')
    ) {
      throw new Error('The scene contains an invalid joint.');
    }
    validateJoint(joints, j.parentId, j.childId);
    joints.push({ ...j, keepConnected: j.keepConnected ?? true });
    jointIds.add(j.id);
  }
  if (data.constraints !== undefined && !Array.isArray(data.constraints))
    throw new Error('The scene contains invalid plane constraints.');
  const constraints: PlaneConstraint[] = [],
    constraintIds = new Set<string>();
  for (const constraint of data.constraints ?? []) {
    const planeValid = (frame: unknown) => {
      const plane = frame as PlaneConstraint['sourcePlane'];
      return (
        plane &&
        finiteTuple(plane.point, 3) &&
        finiteTuple(plane.normal, 3) &&
        Math.abs(Math.hypot(...plane.normal) - 1) < 0.01
      );
    };
    if (
      !constraint ||
      typeof constraint.id !== 'string' ||
      constraintIds.has(constraint.id) ||
      typeof constraint.name !== 'string' ||
      typeof constraint.enabled !== 'boolean' ||
      typeof constraint.opposed !== 'boolean' ||
      !planeValid(constraint.sourcePlane) ||
      !planeValid(constraint.targetPlane)
    )
      throw new Error('The scene contains an invalid plane constraint.');
    constraints.push(constraint);
    constraintIds.add(constraint.id);
  }
  const scene = { name: data.name, parts, joints, constraints };
  validatePlaneConstraints(scene);
  return scene;
}

const dbName = 'kitbasher-workbench';
async function recoveryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('scenes');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function clearRecovery() {
  const db = await recoveryDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('scenes', 'readwrite');
      transaction.objectStore('scenes').delete('current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function saveRecovery(scene: SceneDocument) {
  const file = serializeRecovery(scene),
    db = await recoveryDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('scenes', 'readwrite');
      transaction.objectStore('scenes').put(file, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function readRecovery(): Promise<SceneDocument | null> {
  const db = await recoveryDatabase();
  try {
    const data = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('scenes', 'readonly').objectStore('scenes').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return data ? parseScene(data) : null;
  } finally {
    db.close();
  }
}
