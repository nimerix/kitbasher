import { readFile } from 'node:fs/promises';
import { readSceneFile } from '../../src/core/scene-file';

/** Reads a downloaded .kitbash with the app's own reader. */
export async function readSavedScene(path: string) {
  const bytes = await readFile(path);
  return { scene: await readSceneFile(new Blob([bytes])), bytes };
}
