# Browser sculpting implementation plan

Implement the [Sculpt v1 design](../specs/2026-11-23-browser-sculpting-design.md)
in the existing Three.js workbench. Keep working geometry separate from committed parts.

- [ ] Build and unit-test the editable mesh and brush kernel in `src/core/sculpt-mesh.ts`.
  Verify local conforming subdivision of a coarse triangle, connected footprints, masks,
  seam interpolation, bounded growth, and brush-specific displacement.
- [ ] Add the Sculpt tool, settings and history in `src/core/store.ts`,
  `src/components/SculptControls.tsx` and the existing workbench tool entry points.
  Verify target identity, visibility and lock eligibility before accepting geometry.
- [ ] Connect native pointer input and the editable preview in `src/components/SculptPointer.tsx`
  and `src/components/Viewport.tsx`. Verify pressure and orientation, capture and cancellation,
  occlusion, mask preview, symmetry and a single checkpoint per accepted stroke.
- [ ] Exercise the workflow through the viewport, including undo/redo, automatic detail,
  masking and save/reopen. Run the unit suite and production build.
- [ ] Measure dense-mesh stroke latency and memory. Record physical Wacom results by OS,
  browser, tablet and driver before claiming compatibility.
