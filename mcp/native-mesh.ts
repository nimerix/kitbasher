import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BinaryGeometry } from '../src/core/types';

export type NativeKernelRequest =
  | { mode: 'decimate'; mesh: BinaryGeometry; target: number; error: number; lockBorder: boolean }
  | { mode: 'remesh'; mesh: BinaryGeometry; resolution: number };
export type NativeKernelResult =
  { indices: Uint32Array; error: number } | { positions: Float32Array };

export function nativeMeshExecutable() {
  if (process.env.KITBASHER_NATIVE_MESH === '0' || !['arm64', 'x64'].includes(process.arch))
    return undefined;
  const name = `kitbasher-mesh-native${process.platform === 'win32' ? '.exe' : ''}`;
  const path = fileURLToPath(
    new URL(import.meta.url.endsWith('.ts') ? `../dist-mcp/${name}` : `./${name}`, import.meta.url),
  );
  return existsSync(path) ? path : undefined;
}

/** Native remeshing is opt-in: IPC erased its kernel advantage in the integrated benchmark. */
export function nativeMeshPolicy() {
  const all = process.env.KITBASHER_NATIVE_MESH === 'all';
  return {
    native: !!nativeMeshExecutable() && (all || process.env.KITBASHER_NATIVE_MESH === '1'),
    modes: all ? ['decimate', 'remesh'] : ['decimate'],
    minTriangles: all ? 0 : 50_000,
  };
}

export function useNativeMesh(mode: string, triangles: number) {
  const policy = nativeMeshPolicy();
  return policy.native && policy.modes.includes(mode) && triangles >= policy.minTriangles;
}

export function runNativeKernel(
  request: NativeKernelRequest,
  signal?: AbortSignal,
): Promise<NativeKernelResult> {
  const executable = nativeMeshExecutable();
  if (!executable) return Promise.reject(new Error('Native mesh helper is unavailable.'));
  const { positions } = request.mesh;
  const indices =
    request.mesh.indices instanceof Uint32Array
      ? request.mesh.indices
      : new Uint32Array(request.mesh.indices!);
  const colors = request.mode === 'decimate' ? request.mesh.colors : undefined;
  const header = Buffer.alloc(40);
  [
    0x4b424d31,
    1,
    request.mode === 'decimate' ? 0 : 1,
    positions.length / 3,
    indices.length,
    request.mode === 'decimate' ? request.target : 0,
    request.mode === 'remesh' ? request.resolution : 0,
    request.mode === 'decimate' && request.lockBorder ? 1 : 0,
    colors ? 1 : 0,
  ].forEach((value, i) => header.writeUInt32LE(value, i * 4));
  header.writeFloatLE(request.mode === 'decimate' ? request.error : 0, 36);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = [];
    let size = 0,
      stderr = '',
      failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(error);
    };
    child.on('error', fail);
    child.stdin.on('error', (error) => fail(error));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024 * 1024)
        return fail(new Error('Native mesh output exceeded its memory limit.'));
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (failed) return;
      if (code !== 0) return fail(new Error(stderr.trim() || 'Native mesh processing stopped.'));
      try {
        const result = Buffer.concat(chunks);
        if (
          result.length < 16 ||
          result.readUInt32LE(0) !== 0x4b424d31 ||
          result.readUInt32LE(4) !== (request.mode === 'decimate' ? 0 : 1) ||
          result.readUInt32LE(8) * 4 !== result.length - 16
        )
          throw new Error('Invalid native mesh output.');
        const bytes = new Uint8Array(result.length - 16);
        bytes.set(result.subarray(16));
        resolve(
          request.mode === 'decimate'
            ? { indices: new Uint32Array(bytes.buffer), error: result.readFloatLE(12) }
            : { positions: new Float32Array(bytes.buffer) },
        );
      } catch (error) {
        fail(error as Error);
      }
    });
    const bytes = (array: Float32Array | Uint32Array) =>
      Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    child.stdin.write(header);
    child.stdin.write(bytes(positions));
    child.stdin.write(bytes(indices));
    if (colors) child.stdin.write(bytes(colors));
    child.stdin.end();
  });
}
