import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(resolve(root, 'dist-mcp'), { recursive: true });
const windows = process.platform === 'win32';
const compiler = process.env.CXX || (windows ? 'clang++' : 'c++');
const result = spawnSync(
  compiler,
  [
    '-O3',
    '-DNDEBUG',
    '-ffp-contract=off',
    '-std=c++11',
    'native/mesh-kernel.cpp',
    'native/meshoptimizer/simplifier.cpp',
    'native/meshoptimizer/remesher.cpp',
    'native/meshoptimizer/allocator.cpp',
    '-o',
    `dist-mcp/kitbasher-mesh-native${windows ? '.exe' : ''}`,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error)
  console.error(
    `Native compiler unavailable: ${result.error.message}. Browser and server WASM remain available.`,
  );
process.exitCode = result.status ?? 1;
if (result.status === 0)
  copyFileSync(
    resolve(root, 'native/meshoptimizer/LICENSE.md'),
    resolve(root, 'dist-mcp/meshoptimizer-LICENSE.md'),
  );
