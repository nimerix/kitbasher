# Meshoptimizer 1.3.0 binding

Vendored from `zeux/meshoptimizer`, tag `v1.3`, commit
`9e1f07b159d3cb777f1c67ed31fc11fd117986f4`, under the adjacent MIT license.
The unmodified JavaScript file has SHA-256
`c3098ee4cb4fc242b84f064c88898e76e44bf58b0e1f693507f323c08cdbb5ed`.
Its embedded WASM is unchanged.

Kitbasher's patch only changes the remesh binding: accept an output capacity
(at most one million triangles), allocate once, and reject overflow before
reading the result. This skips the original count-only voxelization pass.
The optional smaller capacity supports overflow regression tests. All other
simplifier operations retain the upstream implementation.

Keep this version aligned with `native/meshoptimizer`, which contains the same
upstream C++ kernels. Upgrade both together and run kernel equivalence tests.
Do not enable fast-math or floating-point contraction when compiling native code.
