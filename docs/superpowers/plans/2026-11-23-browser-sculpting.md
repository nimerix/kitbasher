# Browser sculpting implementation plan

Implement the [Sculpt v1 design](../specs/2026-11-23-browser-sculpting-design.md)
in the existing Three.js workbench. Keep working geometry separate from committed parts.

- [x] Build and unit-test the editable mesh and brush kernel in `src/core/sculpt-mesh.ts`.
      Verify local conforming subdivision of a coarse triangle, connected footprints, masks,
      seam interpolation, bounded growth, and brush-specific displacement.
- [x] Add the Sculpt tool, settings and history in `src/core/store.ts`,
      `src/components/SculptControls.tsx` and the existing workbench tool entry points.
      Verify target identity, visibility and lock eligibility before accepting geometry.
- [x] Connect native pointer input and the editable preview in `src/components/SculptPointer.tsx`
      and `src/components/Viewport.tsx`. Verify pressure and orientation, capture and cancellation,
      occlusion, mask preview, symmetry and a single checkpoint per accepted stroke.
- [x] Exercise the workflow through the viewport, including undo/redo, automatic detail,
      masking and save/reopen. Run the unit suite and production build.
- [x] Measure coarse and dense draft timing and committed mesh size. The sculpt history budget
      is 256 MiB for geometry and 64 MiB for mask snapshots.
- [ ] Record physical Wacom results by OS, browser, tablet and driver before claiming compatibility.

## Viewport measurements

Chrome 158 on Apple M3 with ANGLE Metal. Times cover pointer receipt through Three.js draw
submission for a fitted 3 mm Draw brush. The probe sends each sample after the previous changed
draw. Queued input, GPU completion, and display presentation need separate measurement.

| Fixture                     | First draw | Warm p95 | Warm worst |
| --------------------------- | ---------: | -------: | ---------: |
| 2 triangles                 |    25.2 ms |  17.5 ms |    17.6 ms |
| 999,698 indexed triangles   |    88.0 ms |  25.7 ms |    26.1 ms |
| 999,698 unindexed triangles |   387.9 ms |  29.2 ms |    29.8 ms |

The dense indexed CPU fixture used about 28 MB per committed mesh. Topology changes on dense
meshes may briefly delay the next stroke while picking is rebuilt. The viewport measurements
exceeded the 60 Hz frame budget on the tested fixtures.

Run `KITBASHER_SCULPT_VIEWPORT_BENCH=1 npm run test:e2e -- tests/e2e/sculpt-benchmark.spec.ts` to
repeat the viewport measurements.
