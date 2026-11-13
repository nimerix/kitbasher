# Further mesh-processing acceleration

Investigation of the working tree on `perf/mesh-processing-pipeline`, 2026-11-13. These are findings and isolated prototypes; this investigation does not enable a new runtime backend. The preceding worker/indexing optimizations remain in place.

## Recommended order

| Priority | Change                                                                       | Where it helps                                           | Evidence and limits                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Skip the remesher's separate output-counting pass                            | Every remesh                                             | Measured 30–38% lower WASM kernel time; exact output on four fixtures/settings. Requires a bounded output allocation and overflow handling.                                               |
| 2        | Numeric/native edge-connectivity construction; cache prepared Boolean inputs | Union, subtraction, intersection                         | Edge connectivity accounts for roughly 47–64% of the measured Boolean time. Numeric JavaScript prototype improves cold operations; cached inputs improve repeat operations substantially. |
| 3        | Parallel spatial-index construction and a memory-bounded job pool            | First selection, picking, fitting, independent mesh jobs | Installed library already provides `ParallelMeshBVHWorker`. Integration and browser measurements remain necessary.                                                                        |
| 4        | WebGPU proximity and batched surface-distance queries                        | Nearby-surface isolation and inspection                  | Parallel GPU query code already exists in the installed BVH package. GPU performance has not been measured.                                                                               |
| 5        | Native local helper and targeted WASM SIMD kernels                           | Large local jobs, reduction, remeshing, preparation      | Native ARM64 kernels were faster on this Mac. A helper adds packaging and IPC costs; SIMD needs a custom build and measurements.                                                          |

## 1. Remesh once instead of counting and rebuilding

[Kitbasher's remesh call](/Users/michael/.t3/projects/kitbasher/src/core/mesh-processing.ts:107) reaches a [WASM wrapper](/Users/michael/.t3/projects/kitbasher/node_modules/meshoptimizer/meshopt_simplifier.js:317) that calls `meshopt_remesh` twice: first to count output triangles, then to emit them. The count-only path still constructs and fills a voxel grid. It skips vertex solving, so eliminating it does not halve all remeshing work.

A scratch wrapper allocates space for Kitbasher's existing one-million-triangle output limit and calls the kernel once. Its output positions have identical SHA-256 hashes to the stock wrapper on both fixtures at resolutions 64 and 128.

| Prepared input           | Resolution | Current WASM | Single-pass prototype |
| ------------------------ | ---------: | -----------: | --------------------: |
| Box, 580,800 triangles   |         64 |     27.16 ms |              18.93 ms |
| Box, 580,800 triangles   |        128 |     41.49 ms |              26.72 ms |
| Sphere, 97,792 triangles |         64 |      6.17 ms |               4.08 ms |
| Sphere, 97,792 triangles |        128 |     26.90 ms |              16.70 ms |

This trades the preliminary count for a 36 MB output arena, even for small results. Production integration should preserve the current oversized-output error, verify that a truncated arena is never returned, and account for the WASM heap in the worker memory budget. A maintained binding or upstream change is preferable to modifying an installed npm file. The scratch prototype modified only a temporary copy.

## 2. Boolean topology is a larger target than the triangle arithmetic

[evaluateBoolean](/Users/michael/.t3/projects/kitbasher/src/core/boolean.ts:20) creates fresh brushes for every call. [Brush preparation](/Users/michael/.t3/projects/kitbasher/node_modules/three-bvh-csg/src/core/Brush.js:47) builds a BVH and a half-edge map. [HalfEdgeMap](/Users/michael/.t3/projects/kitbasher/node_modules/three-bvh-csg/src/core/HalfEdgeMap.js:114) constructs position and directed-edge strings in a loop over every triangle.

On two meshes totaling approximately 392,000 triangles, half-edge construction alone took 262–282 ms per operation. The scratch numeric prototype interns quantized vertices and uses numeric directed-edge keys. It retains the installed library's 1e-6/int32 quantization and pairing order. Six adjacency comparisons and six union/subtraction/intersection comparisons matched exactly, including expanded positions, normals, and colors.

| Pair / operation   | Current fresh inputs | Numeric edge prototype | Reused prepared inputs, current engine |
| ------------------ | -------------------: | ---------------------: | -------------------------------------: |
| Boxes / union      |             438.9 ms |               291.4 ms |                                99.9 ms |
| Boxes / subtract   |             408.0 ms |               262.5 ms |                                79.6 ms |
| Spheres / union    |             599.9 ms |               540.0 ms |                               199.7 ms |
| Spheres / subtract |             560.3 ms |               514.7 ms |                               170.9 ms |

The last column is a repeat-input best case, excluding the initial preparation. It is useful for retries, previews, undo/reapply, and reused cutters; a newly cut base still needs new topology. These alternatives are not additive speedups. Validation, transform/color baking, worker startup, and message transfers are outside these timings.

A production implementation should cache by geometry revision and baked transform/color where applicable, evict by resident bytes, and retain cancellation. A native/WASM adjacency builder is a strong next target because it can avoid the remaining JavaScript maps and allocations. The numeric prototype currently falls back for attribute-sensitive and disjoint-edge modes; it is not a replacement for every library configuration. Kitbasher's separate closed-surface check uses a different tolerance, so its welded map cannot simply be substituted.

Additional low-risk candidates: use disjoint bounding boxes to bypass unnecessary solid operations, and avoid repeatedly validating/bounding already-trusted internal geometry. Group only provably disjoint unions; arbitrarily reordering intersecting unions can change triangulation and floating-point results.

## 3. Use more CPU cores where jobs are independent

[Picking indexes](/Users/michael/.t3/projects/kitbasher/src/core/bvh.ts:76) and [display proxies](/Users/michael/.t3/projects/kitbasher/src/core/display-performance.ts:85) each use a serial queue. A 580,800-triangle BVH build took about 95 ms locally. The installed library's [parallel builder](https://gkjohnson.github.io/tools/docs/three-mesh-bvh/ParallelMeshBVHWorker/) distributes a large build across workers and provides a single-worker fallback.

Start with a small, memory-bounded pool for independent jobs. A worker per core without memory accounting would multiply mesh copies and WASM heaps. Parallel BVH construction requires shared buffers and a cross-origin-isolated context. No COOP/COEP configuration was found in the repository's Vite/static/local-server paths; deployed headers were not checked. Browser shared-memory prerequisites are documented by [Emscripten](https://emscripten.org/docs/porting/pthreads.html).

Preserve indirect indices and the original scene buffers. Inspection and CSG currently build their own indexes with different settings; sharing them requires a compatible cache, not blindly reusing whichever tree exists.

[MCP Booleans](/Users/michael/.t3/projects/kitbasher/mcp/session.ts:782) and inspection still execute synchronously on the Node server thread. Moving them to `worker_threads` would keep the server responsive and permit bounded independent jobs. That improves responsiveness; it does not by itself shorten one Boolean calculation. Scene revision checks and atomic application of the result remain necessary.

## 4. Practical GPU entry points

The strongest initial GPU target is [proximity-field construction](/Users/michael/.t3/projects/kitbasher/src/core/proximity.ts:51). It samples surfaces and sweeps the grid from eight directions. [Isolation](/Users/michael/.t3/projects/kitbasher/src/components/Isolation.tsx:120) currently performs this JavaScript work in UI-thread slices, then uploads the result as a WebGL 3D texture. A synthetic field of 1,331,000 nodes took a median 181 ms of CPU work; this is total work spread across yields, not a single 181 ms UI stall.

Move the existing algorithm to a worker first for responsiveness. For GPU acceleration, batch distance-to-surface queries or use a GPU distance-field algorithm. [BVHComputeData and WGSL queries](https://github.com/gkjohnson/three-mesh-bvh/blob/master/WEBGPU_API.md) are already available in the installed package, including closest-point and ray queries. The upstream API is marked unstable, so pin and isolate the adapter.

[Inspection surface bands](/Users/michael/.t3/projects/kitbasher/src/core/inspection.ts:90) are another batch-query candidate. Their adaptive clipping would need restructuring into batches before dispatching to GPU compute. Keep exact CPU checks for final geometric decisions until comparison tests establish suitable error bounds.

A compute backend can be introduced alongside the WebGL viewport. WebGPU results would need readback for the existing WebGL texture and CPU picking checks; that cost belongs in the benchmark. A renderer migration alone does not move these algorithms onto the GPU. [WebGPU compute](https://developer.chrome.com/docs/capabilities/web-apis/gpu-compute) supplies the execution mechanism, not a Boolean/remeshing implementation.

GPU remeshing is a later project: voxelization, inside/outside classification, vertex solving, and surface extraction need an explicit implementation and topology validation. No GPU speedup is claimed by this investigation.

## 5. Native and SIMD opportunities

Reduction/remeshing already use C++ compiled to WASM. The exact installed 1.3.0 simplifier matches upstream tag `v1.3` byte-for-byte. Its [build configuration](https://github.com/zeux/meshoptimizer/blob/v1.3/Makefile) targets baseline WASM and disables auto-vectorization; the separately optimized SIMD decoder is not the simplifier.

A native ARM64 build of that source, compiled with `-O3 -DNDEBUG -ffp-contract=off`, gave these prepared-input kernel times:

| Kernel                             | Stock WASM | Native C++ |
| ---------------------------------- | ---------: | ---------: |
| Box reduction, 580,800 triangles   |  110.69 ms |   84.89 ms |
| Sphere reduction, 97,792 triangles |   12.28 ms |    9.54 ms |
| Box remesh, resolution 128         |   41.49 ms |   25.82 ms |
| Sphere remesh, resolution 128      |   26.90 ms |   16.63 ms |

All six native output buffers, including the two resolution-64 runs, matched the WASM output hashes. This establishes equivalence only for these fixtures. Native timings exclude process startup and IPC, and use the same two-call remesh procedure as the stock wrapper. Single-pass browser WASM already captures much of the measured native remesh advantage.

An optional local helper could serve the existing Node/MCP/headset host, with a browser WASM fallback. Packaging, binary transfer, cancellation, and architecture-specific validation are real implementation costs. Native Manifold with TBB is another local-backend experiment; the [upstream README](https://github.com/elalish/manifold) distinguishes its native parallel backend from its serial WASM release and cautions against the threaded WASM build.

For browser acceleration, prototype WASM SIMD on bulk preparation: transforms, normals, bounds, attribute packing, and numeric topology. [Emscripten supports SIMD](https://emscripten.org/docs/porting/simd.html), but merely adding the compiler flag does not guarantee a faster simplifier. Preserve floating-point semantics; there is no measured SIMD speedup yet. Keeping prepared inputs in a persistent WASM allocation could also avoid the wrappers copying them into the WASM heap on every attempt; the current worker cache retains JavaScript-side arrays.

One additional hardware opportunity is [MCP image rendering](/Users/michael/.t3/projects/kitbasher/mcp/render.ts:9): it deliberately rasterizes triangles on the CPU. A GPU rendering backend could accelerate agent snapshots while retaining the CPU fallback. This affects snapshot generation, not the browser's already-accelerated viewport or mesh operations.

## Engine replacement is not an automatic win

The earlier Manifold experiment was mixed: it was faster for the tested boxes and slower for the tested spheres when conversion and preparation were included. It also changed triangulation and slightly changed sphere volumes. Keep it as a separately validated backend experiment rather than assuming any WASM engine will outperform the current JavaScript engine on every mesh.

## Reproduction and limits

Measured on this Mac's Apple M4 Max, 14 logical CPU cores, Node v25.2.0. Timing medians use five samples; kernel runs omit a warmup. No concurrent benchmark jobs were run. Inputs are synthetic boxes and spheres, not the user's dense scans. No browser, physical-headset, GPU, or multi-core speedup is established here.

Scratch artifacts:

- [Consolidated results](/tmp/kitbasher-acceleration-yBGCOm/results.json)
- [WASM and single-pass benchmark](/tmp/kitbasher-acceleration-yBGCOm/kernels.mjs)
- [Native benchmark](/tmp/kitbasher-acceleration-yBGCOm/native.cpp)
- [Boolean preparation benchmark](/tmp/kitbasher-acceleration-yBGCOm/booleans.mjs)
- [Numeric connectivity prototype](/tmp/kitbasher-acceleration-yBGCOm/numeric-halfedges.mjs)
- [Numeric equivalence check](/tmp/kitbasher-acceleration-yBGCOm/verify-numeric.mjs)

Full runtime tests were not rerun because this follow-up changes only investigation notes. Prototype correctness checks are scoped evidence, not approval to replace production algorithms without regression and real-scan validation.
