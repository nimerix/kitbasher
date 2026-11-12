import type { BufferGeometry } from 'three';
import {
  appendGeometry,
  assertReadable,
  parseScene,
  parseSceneDocument,
  readGeometry,
  sceneMetadata,
  validateLayout,
} from './scene-file';
import { readDriveBinding } from './google-drive';
import type { DriveFileBinding, GeometryLayout, Part, SceneDocument } from './types';

interface RecoverySnapshot {
  scene: SceneDocument;
  driveFile: DriveFileBinding | null;
}

const databaseName = 'kitbasher-workbench';
const scenes = 'scenes';
const meshes = 'geometries';
const currentScene = 'current';

interface StoredMesh {
  layout: GeometryLayout;
  data: Blob;
}
type StoredPart = Omit<Part, 'geometry'> & { geometry: string };

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    request.onupgradeneeded = () => {
      for (const store of [scenes, meshes])
        if (!request.result.objectStoreNames.contains(store))
          request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const requested = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function finished(transaction: IDBTransaction) {
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  // A failed request can reject first, leaving nothing awaiting this promise.
  done.catch(() => {});
  return done;
}

async function storeMesh(db: IDBDatabase, key: string, geometry: BufferGeometry) {
  const body: BlobPart[] = [];
  const { layout } = appendGeometry(geometry, body, 0);
  const data = new Blob(body);
  await assertReadable(data);
  const transaction = db.transaction(meshes, 'readwrite');
  const done = finished(transaction);
  transaction.objectStore(meshes).put({ layout, data } satisfies StoredMesh, key);
  await done;
}

/** Atomically publishes the scene and drops unused meshes, unless a mesh it needs has gone. */
async function commitScene(db: IDBDatabase, file: object, keys: Set<string>) {
  const transaction = db.transaction([scenes, meshes], 'readwrite');
  const done = finished(transaction);
  const store = transaction.objectStore(meshes);
  const stored = new Set(await requested(store.getAllKeys()));
  const complete = [...keys].every((key) => stored.has(key));
  if (complete) {
    transaction.objectStore(scenes).put(file, currentScene);
    for (const key of stored) if (!keys.has(key as string)) store.delete(key);
  }
  await done;
  return complete;
}

/** A failed write must not leave partial meshes holding the storage quota. */
async function removeOrphanMeshes(db: IDBDatabase) {
  const transaction = db.transaction([scenes, meshes], 'readwrite');
  const done = finished(transaction);
  const store = transaction.objectStore(meshes);
  const [stored, current] = await Promise.all([
    requested(store.getAllKeys()),
    requested(transaction.objectStore(scenes).get(currentScene)),
  ]);
  const inUse = new Set(
    current?.version === 2 ? current.parts.map((part: StoredPart) => part.geometry) : [],
  );
  for (const key of stored) if (!inUse.has(key)) store.delete(key);
  await done;
}

// Meshes never change once they are in a scene, so each is written once. After that, an
// edit only rewrites the scene's metadata, however large the scene is.
async function writeRecovery({ scene, driveFile }: RecoverySnapshot) {
  const geometries = new Map(scene.parts.map((part) => [part.geometry.uuid, part.geometry]));
  const file = {
    ...sceneMetadata(scene),
    driveFile,
    parts: scene.parts.map((part) => ({ ...part, geometry: part.geometry.uuid })),
  };
  const keys = new Set(geometries.keys());
  const db = await openDatabase();
  try {
    // Another window sharing this save can remove meshes between these steps.
    for (let attempt = 0; attempt < 3; attempt++) {
      const stored = new Set(
        await requested(db.transaction(meshes).objectStore(meshes).getAllKeys()),
      );
      for (const [key, geometry] of geometries)
        if (!stored.has(key)) await storeMesh(db, key, geometry);
      if (await commitScene(db, file, keys)) return;
    }
    throw new Error('Another window keeps replacing the local save.');
  } catch (error) {
    await removeOrphanMeshes(db).catch(() => {});
    throw error;
  } finally {
    db.close();
  }
}

let queued: RecoverySnapshot | null = null;
let writing: Promise<void> | null = null;

/** Writes run one at a time, and only the newest waiting scene is kept. */
export function saveRecovery(
  scene: SceneDocument,
  driveFile: DriveFileBinding | null = null,
): Promise<void> {
  queued = { scene, driveFile };
  writing ??= (async () => {
    try {
      while (queued) {
        const next = queued;
        queued = null;
        await writeRecovery(next);
      }
    } finally {
      writing = null;
    }
  })();
  return writing;
}

export async function readRecovery(): Promise<RecoverySnapshot | null> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction([scenes, meshes]);
    const data = await requested(transaction.objectStore(scenes).get(currentScene));
    if (!data) return null;
    // Autosaves from earlier versions hold their meshes inside the scene record.
    if (data.version !== 2) return { scene: parseScene(data), driveFile: null };
    const keys: string[] = [
      ...new Set<string>(data.parts.map((part: StoredPart) => part.geometry)),
    ];
    const store = transaction.objectStore(meshes);
    const records: (StoredMesh | undefined)[] = await Promise.all(
      keys.map((key) => requested<StoredMesh | undefined>(store.get(key))),
    );
    const geometries = new Map<string, BufferGeometry>();
    for (const [i, key] of keys.entries()) {
      const record = records[i];
      if (!record) throw new Error('The local save is missing a mesh.');
      validateLayout(record.layout, 0, record.data.size);
      const geometry = await readGeometry(record.data, record.layout);
      // Keeping the stored key means this mesh is not written again.
      geometry.uuid = key;
      geometries.set(key, geometry);
    }
    const scene = parseSceneDocument(data, 2, (reference) => {
      const geometry = geometries.get(reference as string);
      if (!geometry) throw new Error('The local save is missing a mesh.');
      return geometry;
    });
    return { scene, driveFile: readDriveBinding(data.driveFile) };
  } finally {
    db.close();
  }
}

export async function clearRecovery() {
  const db = await openDatabase();
  try {
    const transaction = db.transaction([scenes, meshes], 'readwrite');
    const done = finished(transaction);
    transaction.objectStore(scenes).delete(currentScene);
    transaction.objectStore(meshes).clear();
    await done;
  } finally {
    db.close();
  }
}
