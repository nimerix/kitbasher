# Meshoptimizer 1.3.0 binding

Vendored from `zeux/meshoptimizer`, tag `v1.3`, commit
`9e1f07b159d3cb777f1c67ed31fc11fd117986f4`, under the adjacent MIT license.
The unmodified JavaScript file has SHA-256
`c3098ee4cb4fc242b84f064c88898e76e44bf58b0e1f693507f323c08cdbb5ed`.

Kitbasher's remesh binding accepts an output capacity (at most one million
triangles), allocates once, and rejects overflow before reading the result.
This skips the original count-only voxelization pass. The shared C++ kernel
caps occupied-voxel storage at 128 MiB before allocating it. At resolution
256, the grid and row data take at most 17 MiB and the output arena takes
about 35 MiB. This bounds remeshing workspace to about 180 MiB, excluding
input, preparation and the returned mesh. All other simplifier operations
retain the upstream implementation.

To regenerate the embedded WASM from this repository's root, use a clean
checkout of the pinned upstream commit and WASI SDK 32.0. Set
`meshoptimizer_checkout` and `wasi_sdk_dir` to their absolute paths, then run:

```sh
cp native/meshoptimizer/remesher.cpp "$meshoptimizer_checkout/src/remesher.cpp"
make -C "$meshoptimizer_checkout" WASI_SDK="$wasi_sdk_dir" build/simplifier.wasm
python3 "$meshoptimizer_checkout/tools/wasmpack.py" patch \
  src/vendor/meshoptimizer/simplifier.js wasm < "$meshoptimizer_checkout/build/simplifier.wasm"
```

Upgrade the WASM and native source together and run kernel equivalence tests.
Keep fast-math and floating-point contraction disabled in native builds.
