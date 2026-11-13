# Mesh processing performance

The browser merge pipeline now runs validation, transform/color baking, combination or Boolean evaluation, recentering, normals, and bounds in a worker. Returning a result attaches its buffers without recomputing the full mesh on the UI thread. Source buffers remain owned by the editor; cancellation terminates the active worker and stale scene results are rejected.

Indexed geometry is preserved when it can reproduce the original triangle data. Inputs without normals or with unreferenced vertices retain the original expansion behavior so flat shading, bounds, and pivots remain unchanged. Numeric welding uses the existing 1e-5 quantization and first-use ordering; edge checks use sorted numeric keys. Successful validation is cached against geometry/attribute identity and version, including in MCP operations.

Reduction and remeshing reuse one prepared source in an idle worker. Reuse is restricted to inputs of at most 128 MiB. The worker expires after 30 idle seconds, when its source geometry is disposed, or when the page is left. Cancellation or failure discards the worker. Attribute changes invalidate the prepared source. Only one idle worker is retained; active jobs remain independently cancellable.

## Measurements

Local Node v25.2.0 CPU measurements, median of three sequential runs against baseline commit `272fe8e`. Each input is a 580,800-triangle subdivided box; combining uses two inputs. Reduction/remeshing use non-indexed inputs. These are algorithm measurements, excluding browser scheduling, message copies, worker startup, GPU uploads, and user scan complexity.

| Operation                  |   Before |    After |
| -------------------------- | -------: | -------: |
| Combine two indexed meshes | 134.5 ms |  59.5 ms |
| Check one closed surface   | 691.1 ms |  93.6 ms |
| Reduce to 25%              | 193.5 ms | 146.8 ms |
| Remesh at resolution 64    | 156.6 ms | 128.9 ms |

The combined geometry's position, normal, color, and index buffers fell from 125,452,800 to 35,038,512 bytes (72.1% less). In the repeat-operation benchmark, cached remeshing took a median 28.3 ms after a 129.5 ms first run. These results do not establish live dense-scene latency or headset performance.

## Correctness and verification

- `npm test`: 850 tests passed; the two profiling tests are opt-in.
- `npm run build`: browser and MCP builds passed, including TypeScript checking.
- Eight targeted Playwright cases passed: real worker combination and Boolean union, cancellation, stale merge rejection, prepared-source reuse, decimation/save/undo, remesh cancellation, and display proxies.
- Exact triangle positions, normals, and colors match the previous preparation for union, subtraction, and intersection after index expansion.
- Combined STL bytes match for mirrored, tinted, and mixed indexed/non-indexed meshes. Flat normals and unused-position outliers have dedicated regressions.
- Six separate baseline/optimized output hashes match for colored box/sphere reduction and remeshing. Worker result transfers do not detach cached preparation or the original scene buffers.

Run the repeatable current-code benchmark with:

```sh
KITBASHER_MESH_BENCH=local npm test -- tests/unit/mesh-pipeline-benchmark.test.ts
```

It writes `kitbasher-performance/mesh-local.json` in the system temporary directory. Timing assertions are excluded from the normal test suite.

## Engine choice

Manifold 3.5.5 was benchmarked separately against the current Boolean engine on overlapping subdivided boxes and spheres. It was faster on the tested boxes and slower on the tested spheres when conversion and preparation were included. It also produced different triangulations and slightly different computed sphere volumes. The production dependency and Boolean engine remain unchanged; adopting it requires a separate dense-scan fidelity evaluation.

WebGPU is not enabled by this change. The current WASM remesher has no WebGPU switch, and moving voxelization and surface extraction to GPU compute would require a separate implementation with its own geometry-equivalence checks. The measured preparation and threading improvements apply without a renderer migration. MCP Boolean evaluation itself still runs synchronously, though it benefits from faster validation, caching, and indexed preparation.
