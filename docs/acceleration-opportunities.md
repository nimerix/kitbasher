# Mesh acceleration implementation

Implemented on `perf/mesh-processing-pipeline`, 2026-11-13. This replaces the earlier prototype-only investigation. Rendering continues to use WebGL; WebGPU compute is used independently for nearby-surface fields.

## Runtime paths

| Work                                     | Implementation                                                                        | Activation and fallback                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Remeshing                                | Vendored meshoptimizer binding skips the count-only voxelization pass                 | Default browser/server WASM path; one-million-triangle capacity, overflow rejected before reading output                           |
| Boolean union, subtraction, intersection | Numeric vertex/edge connectivity with the original CSG quantization and pairing order | Default; unsupported half-edge settings use the upstream implementation                                                            |
| Repeated Booleans                        | Prepared brushes cached by geometry revision, transform and tint                      | 96 MiB retained-data budget per processor; browser union and MCP Boolean workers expire after 30 idle seconds                      |
| Picking indexes and display proxies      | Shared queue admits independent background jobs across CPU cores                      | At most two jobs on machines with at least four logical cores; one otherwise; 256 MiB estimated working budget                     |
| Large picking indexes                    | Installed parallel BVH builder with indirect indexing                                 | At least 500,000 triangles, four logical cores and cross-origin isolation; normal worker fallback on failure                       |
| MCP merge and interference inspection    | Bounded Node worker pool                                                              | At most two jobs, 512 MiB estimated working budget; cancellation terminates active computation; stale scene results are rejected   |
| Nearby-surface isolation                 | Worker field construction; WebGPU nearest-triangle distance batches                   | Hardware adapters only, at least 32,768 grid nodes; CPU worker fallback for unsupported adapters, resource limits or device errors |
| Local native reduction                   | Same meshoptimizer C++ source compiled for the host                                   | Optional build and explicit host opt-in; default policy uses it only for reductions of at least 50,000 triangles                   |

Memory admission estimates include copies and scratch space; they are not hard process-memory limits. An oversized job runs alone. Very large completed jobs release their workers rather than retaining their heaps. Boolean cache eviction occurs after an operation, so active inputs remain valid throughout it.

Source buffers remain owned by the scene. Worker transfers contain copied inputs or independently owned results. Native previews do not modify the shared scene; the normal review/apply/undo flow applies them.

The GPU path affects the approximate nearby-surface display and its matching picking mask. It does not perform solid Booleans, reduction, remeshing, interference-volume decisions or print/export geometry changes. `surfaceDistances` also provides a reusable batched-query API with an exact-triangle CPU fallback. Inspection's adaptive surface-band algorithm still uses CPU queries.

## Optional native helper

```sh
npm run build:native
KITBASHER_NATIVE_MESH=1 npm run headset
```

The compiler is `c++` (`clang++` on Windows), or `$CXX`. The binary is written beside the server bundles in `dist-mcp/`. An MCP client can set the same environment variable when starting `kitbasher-mcp.js`. Build the application/server bundles with `npm run build` when installing or updating it.

`KITBASHER_NATIVE_MESH=1` enables native reduction for sufficiently large inputs. Remeshing stays on single-pass WASM: the measured native kernel benefit was lost to process startup and transfers. `KITBASHER_NATIVE_MESH=all` enables both kernels, including small inputs, for testing or host-specific profiling. Native execution is disabled without explicit opt-in. A missing or failed helper falls back to WASM.

Static deployments remain entirely browser-based. The authenticated local/shared host serves native previews only to its connected editor. No new remote service is involved.

Native code is compiled with `-O3 -DNDEBUG -ffp-contract=off`, without fast-math. The source version and licenses are recorded in `native/README.md` and `src/vendor/meshoptimizer/README.md`. Native compilation and output equivalence were verified on this Mac's ARM64 CPU; Windows/x64/Linux builds need their own validation.

## Optional parallel BVH construction

For Vite development or the local/shared host:

```sh
KITBASHER_CROSS_ORIGIN_ISOLATED=1 npm run dev
# or
KITBASHER_CROSS_ORIGIN_ISOLATED=1 npm run headset
```

This sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Static hosts must configure equivalent headers themselves. These headers are opt-in because they change cross-window communication and cross-origin resource loading. Ordinary background-job parallelism and GPU compute do not require this opt-in.

The adapter is pinned to `three-mesh-bvh` 0.9.18. It avoids that version's ignored rejecting `finally()` promise, owns worker cleanup, and abandons a stalled parallel builder after 30 seconds so the ordinary worker can proceed. Updating the dependency requires rerunning the parallel/cancellation tests. CSG is likewise pinned at 0.0.18 because the numeric adapter relies on its preparation contract.

## Integrated measurements

Synthetic tests on this Mac (Apple M4 Max). Medians exclude one warmup. These are scoped measurements, not promises for arbitrary scans.

For a prepared 580,800-triangle box, five measured runs:

| Operation                | Path                                            |    Median |
| ------------------------ | ----------------------------------------------- | --------: |
| Remesh at resolution 128 | Stock two-pass binding, `MeshProcessor.process` |  34.22 ms |
| Remesh at resolution 128 | Single-pass binding, same processing            |  23.00 ms |
| Remesh at resolution 128 | Server worker, single-pass WASM                 |  37.23 ms |
| Remesh at resolution 128 | Server worker, native helper                    |  40.13 ms |
| Reduce to 25%            | Server worker, WASM                             | 119.12 ms |
| Reduce to 25%            | Server worker, native helper                    | 108.68 ms |

The server timings include content hashing, worker messages, result normals/bounds, native process startup and IPC. They exclude browser HTTP transport. These results explain why native remeshing is not selected by the normal policy and why local native processing is opt-in.

Chrome's hardware Apple `metal-3` WebGPU adapter was used for these worker-field measurements, with three measured runs. They include worker startup, mesh copying, BVH preparation, GPU upload, compute, readback and byte encoding in the Vite development build:

| Proximity input              | CPU worker | WebGPU worker |
| ---------------------------- | ---------: | ------------: |
| Coarse box, 12 triangles     |   289.9 ms |      232.7 ms |
| Dense box, 196,608 triangles |   314.7 ms |      311.5 ms |

The dense result is effectively even at this sample count. GPU compute is not assumed to improve every mesh. Physical-headset performance and other GPU/browser implementations have not been measured.

Raw local diagnostics: `/tmp/kitbasher-integrated-acceleration.json` and `/tmp/kitbasher-gpu-acceleration.json`. Reproduce them with:

```sh
KITBASHER_ACCELERATION_BENCH=1 npm test -- tests/unit/acceleration-benchmark.test.ts
KITBASHER_ACCELERATION_BENCH=1 npm run test:e2e:acceleration -- --grep profiles
```

## Correctness and regression coverage

Completed locally: 875 unit tests, 20 targeted Chrome checks, TypeScript, production and
native builds, formatting, and whitespace checks. Three unit timing diagnostics and one
browser timing diagnostic are opt-in; their measured runs are described above.

- Single-pass versus stock remeshing: exact output at resolutions 24, 64 and 128, plus overflow rejection and a subsequent successful run.
- Numeric half-edge adjacency: stock equality for indexed/unindexed meshes, duplicate and degenerate edges, quantization boundaries and large coordinates.
- Boolean union, subtraction and intersection: exact positions, indices, normals and colors against the stock evaluator on transformed/mirrored fixtures.
- Native versus WASM: exact mesh buffers for plain/colored reductions and remeshing fixtures; invalid input, disabled backend and cancellation coverage.
- WebGPU: 70,019 distance queries across multiple batches, transformed/mirrored meshes and a degenerate face. Maximum CPU/GPU difference on this hardware was approximately 0.0000015 mm. This does not establish bitwise equivalence for every GPU.
- CPU field worker: exact equality with the existing field generator, source ownership and cancellation.
- Parallel BVH: original position/index arrays unchanged, correct nearest-surface result; cancellation, rejection and stalled-worker fallback coverage.
- MCP: background merge rejects concurrent scene changes; HTTP preview processing leaves the shared scene unchanged.

Run `npm test`, `npm run build`, `npm run test:e2e:acceleration`, and the mesh-processing/isolation/MCP browser tests. The isolated-browser suite supplies the required response headers. Native tests skip when the optional helper is absent; build it first to include that coverage.

## Further work

No SIMD speedup is claimed. The vendored simplifier's embedded WASM is unchanged; only its remesh binding is patched. A SIMD build needs separate profiling and equivalence checks. Native adjacency kernels, GPU solid operations, inspection surface-band batching and a GPU MCP snapshot renderer remain separate projects. The previous Manifold experiment changed triangulation and did not consistently beat the existing engine, so the Boolean engine is retained.
