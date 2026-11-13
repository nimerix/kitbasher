# Optional native mesh kernels

`meshoptimizer/` contains unmodified source files from `zeux/meshoptimizer` tag
`v1.3`, commit `9e1f07b159d3cb777f1c67ed31fc11fd117986f4`, under its included MIT
license. Keep these aligned with `src/vendor/meshoptimizer/`.

`mesh-kernel.cpp` is Kitbasher's bounded, one-job binary stdin/stdout adapter.
It reduces indexed meshes, including colors and locked borders, or remeshes into
an arena of at most one million triangles. It validates dimensions, finite data
and index bounds before entering the kernel. It reads no scene files and opens
no network connections.

Build with `npm run build:native`. Use `KITBASHER_NATIVE_MESH=1` when launching the
local host to opt into native reduction; `all` additionally enables remeshing
and small inputs for profiling. Missing/failed helpers fall back to WASM.

The parent server owns each native process, so cancellation kills it before
terminating the compute worker. The protocol uses little-endian float32/uint32
on x64 and arm64. Compilation uses `-ffp-contract=off` and no fast-math; run the
native equivalence tests on each supported architecture/compiler before shipping
its binary. Only macOS ARM64 has been validated in this change.
