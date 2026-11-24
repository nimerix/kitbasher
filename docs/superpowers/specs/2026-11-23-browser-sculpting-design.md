# Browser sculpting v1

Status: proposed for review.

## Intent

Add freehand sculpting to Kitbasher's browser workbench, with ZBrush and Blender as workflow
references. The user chose automatic detail under the brush for the first release and asked
for full Wacom tablet support, masking, and advanced brush parameters. The brush set, controls,
and implementation below are proposed.

## Approaches

- **Local edge subdivision (recommended).** Split long edges as the brush passes over a coarse
  area. Each split preserves the original triangle surfaces until the brush moves them. This
  needs a growth limit and a picking index that can keep up with changing topology.
- **Local subdivision and edge collapse.** Also remove short edges to control density. This
  adds geometric simplification, attribute transfer, and checks around boundaries and creases.
- **Voxel remeshing.** Kitbasher's current worker reconstructs a closed mesh and drops vertex
  colors. Running it on a brush patch would require stitching the patch back into the source,
  and can change thin features and open surfaces.

## Workbench behavior

Select one visible, unlocked part and choose **Sculpt** in the workbench toolbar. Keep the part
in its assembly so nearby parts remain visible. The panel shows the brush, radius, strength,
detail, and local X symmetry. Show a surface-aligned cursor at the hit under the tip and preview
the mirrored hit when symmetry is enabled. Start each direct dab on the nearest visible surface
under the tip, and act only when it belongs to the selected part. Resolve the mirror against a
nearby surface on that same part, including the far side when symmetry explicitly calls for it.
If the mirrored and direct footprints overlap, apply at most one dab's effect per vertex.

The brush set includes Draw, Grab, Smooth, Flatten, Crease, and Mask. Draw raises the surface or
digs into it when inverted. Grab moves a patch with the pen. Smooth and Flatten use the local
surface and follow the existing Refine behavior where it suits freehand strokes. Crease pulls the
surface toward the stroke path while cutting a groove. Invert the depth to form a sharp ridge.
Holding Shift temporarily switches to Smooth on the sculpting brushes. In Mask mode it temporarily
softens the mask.

Strokes preview in the viewport and commit on release. One undo or redo covers deformation and
all topology changes from that stroke. Escape, pointer cancellation, lost capture, blur, or an
external change to the target discards the active stroke. Leaving Sculpt keeps completed strokes.
Commit against the target part's identity, source mesh, and pose. Follow Refine's behavior of
keeping existing pins, anchors, pivot, joints, and constraint frames during a geometry edit.
Committed geometry saves, exports, and shares through the existing part geometry paths. Start
with imported meshes. Later releases can address starter meshes, alphas, sculpt layers, and XR.

## Advanced brush parameters

Keep everyday controls visible and group advanced parameters in a collapsible section. Offer a
reset to the defaults for the active brush. Preserve each brush's settings when switching brushes.

| Group | Proposed controls |
| --- | --- |
| Falloff | Soft, linear, and hard profiles control how strength falls toward the edge. |
| Stroke | Dab spacing as a fraction of brush size and optional stroke stabilization. |
| Pressure | Separate strength and radius toggles and a pressure response curve. |
| Draw footprint | Round or elliptical, with roundness, rotation, and optional tilt or twist input. |
| Crease | Pinch controls how tightly the brush draws the surface toward the stroke path. |
| Detail limits | Minimum edge size bounds local refinement at the selected detail level. |

Show controls only where the active brush uses them. Update the cursor when radius, footprint,
or symmetry changes. Apply parameter changes to subsequent strokes so the current stroke uses a
consistent configuration.

## Masking

- Paint protection with Mask. Use the inverse gesture to erase, Shift to soften the mask, and
  offer Invert and Clear for the whole part. Show protection as an overlay with a visibility toggle.
- Mask weights range from zero to one. Partial protection scales down brush displacement and full
  protection keeps a point fixed. Use the same connected-surface and symmetry rules as sculpt dabs.
  Pressure-sensitive mask strength follows the pen settings.
- Use automatic subdivision for fine mask strokes on coarse faces. Preserve the surface during
  those splits and interpolate existing mask weights onto the new vertices, including at seams.
  Commit any new triangles alongside the mask stroke, and skip geometry commits when the mesh
  stays identical. Fully masked sculpt dabs leave the mesh untouched.
- Keep masks as temporary state for the selected part while Sculpt is open. Within Sculpt,
  undo and redo cover mask edits and geometry strokes in order. Roll back both on cancellation
  or a refused stroke. Leaving Sculpt clears the overlay and temporary weights. Saved and exported
  parts include committed mesh detail.

## Automatic detail

- Use the visible hit triangle to seed a connected surface patch. Test triangle overlap with the
  brush footprint so a small dab inside a single coarse triangle can still create useful detail.
  Stop at disconnected shells and avoid catching the opposite face of a thin wall.
- Refine long edges in the patch to a target derived from radius and detail, with a minimum edge
  length in scene units. Split all incident faces of each chosen edge for conformity, including
  neighbors just outside the brush. Retain their surface shape, open boundaries, winding, and
  seams. Interpolate normals and supported attributes along each render edge. Use a shared
  geometric midpoint with separate render vertices where attributes differ.
- Bound per-frame subdivision work and total growth. At the growth limit, show a brief status and
  keep brushing at the available density. Roll back subdivision when the stroke changes neither
  surface shape nor mask weights. Treat invalid triangles and ambiguous edges as patch boundaries
  so usable areas of a damaged scan remain sculptable.
- Keep mutable stroke data separate from saved geometry. Update picking against current triangles
  and refresh changed positions and normals locally. Batch splits so a pen sample never triggers
  a whole-part topology or GPU rebuild in the input handler. Refine's seam handling and vertex
  updates are precedents. Its fast preview currently requires unchanged topology.

## Wacom behavior

- Use browser Pointer Events for pen tip, hover, pressure, buttons, and orientation. Consume
  coalesced samples where available and resample by brush-relative spacing. Use individual events
  as the fallback. Mouse input has steady strength. Touch stays available for navigation outside
  the active stroke and secondary contact cannot paint or move the camera during pen contact.
- Enable pressure-sensitive strength by default. Offer pressure-sensitive radius and a pressure
  curve. Give a pen barrel button viewport navigation and map the physical eraser to inverted Draw
  when the browser exposes those buttons. Use reported tilt to orient an optional angled Draw
  footprint and use twist to rotate it when available. Round brush settings work with default or
  unavailable orientation data. Keep keyboard and mouse equivalents for brush actions.
- Verify on a physical Wacom Intuos and Cintiq. Start with Windows and macOS in Chromium, then
  record the browser, OS, tablet, pen, driver, and features actually delivered for every supported
  combination. The proposed launch matrix covers the capabilities exposed by those combinations.
  Automated synthetic pen tests establish application behavior. Physical testing establishes tablet
  support. [Wacom browser API](https://developer-docs.wacom.com/docs/icbt/web/web-api-overview/)

## Verification

- Unit tests cover coarse-triangle dabs, shared splits, open edges, indexed and unindexed inputs,
  hard normals and vertex colors, thin and disconnected shells, isolated non-manifold regions,
  transformed parts, growth limits, and exact stroke undo and redo. Existing positions beyond the
  brush footprint must stay bit-identical.
- Browser tests cover tool entry, live preview, picking after a split, pressure ramps, modifiers,
  navigation, cancellation, undo, save/reopen, and shared-scene commit and rejection. A discarded
  stroke must leave the committed geometry and history untouched.
- Verify mask painting, erasing, softening, inverting, clearing, and undo across subdivision. Test
  that fully protected points keep their positions, partial protection scales the displacement,
  and new vertices inherit interpolated weights. Verify that advanced settings affect subsequent
  strokes, persist across brush switches, and reset to the active brush's defaults.
- Verify that Crease forms a groove or an inverted ridge on coarse and dense meshes, respects
  masking, and undoes its deformation and added topology together.
- Profile input-to-preview latency and retained history memory on a coarse mesh and an approximately
  one-million-triangle scan. Use a recorded reference browser and machine. Aim for updates by
  the next frame on a 60 Hz display during sustained strokes. Record p95 and worst-case latency,
  and set supported mesh sizes and byte limits from the measured budgets before launch. Cap
  retained sculpt history by bytes to avoid retaining an unbounded series of dense meshes.
- Run `npm test`, `npm run test:e2e -- tests/e2e/sculpt.spec.ts`, and `npm run build`. Run a physical
  tablet pass for hover, slow pressure ramps, fast strokes, barrel navigation, eraser, tilt, twist,
  incidental touch, and cancellation where the hardware provides those inputs.

## Build order

Mesh subdivision and transactional stroke editing first, followed by viewport picking and input,
then masking, advanced brush parameters, and tablet controls. Measure the coarse and dense
fixtures as soon as the first Draw stroke works end to end. Keep the file format and dependencies
unchanged unless the implementation demonstrates a need to revisit them.
