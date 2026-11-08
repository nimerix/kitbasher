# Spec: Precision interaction and painted plane constraints

**Author:** Codex
**Date:** 2026-11-07
**Status:** Approved
**Reviewers:** Codex self-review against the user's requested editor behavior
**Related specs:** [Workbench design](design.md)

## Context

The user cannot reliably orbit while collecting matching points or painting contact patches. Surface painting disables camera rotation, and the existing brush includes nearby triangles without testing surface connectivity. This makes accurate scan assembly difficult.

This change adds navigation during either picking workflow, continuous precision transforms, connected paint selection with an optional fixed seed-plane filter, and editable plane relationships. It extends the existing joint and best-fit systems and keeps existing native scene files readable.

## Functional Requirements

- FR-1: The viewport MUST allow middle-drag orbit and temporary Space + left-drag orbit during point picking and surface painting without adding picks or paint.
- FR-2: Shift MUST reduce incremental gizmo translation, rotation, and scale changes to 0.1 of their normal sensitivity without jumping when pressed or released during a drag.
- FR-3: Each painted patch MUST remain connected through shared mesh edges, including coincident edges in nonindexed scans; subsequent strokes MUST NOT add a disconnected island.
- FR-4: Painting MUST offer an optional seed-plane filter with adjustable normal-angle and world-distance tolerances, anchored to the patch's first paint hit.
- FR-5: Erasing MUST retain one connected patch, keeping the original seed component when possible and otherwise the largest remaining component.
- FR-6: Painted surface alignment MUST offer mate with signed offset, parallel, perpendicular, and normal-angle relationships in addition to the existing 3+ pair contact best fit. Plane methods MUST accept one or more complete patch pairs and use area-weighted fitted planes.
- FR-7: Plane relationships MUST optionally persist as named enabled constraints with editable kind, angle, offset, and normal direction, plus suppress and delete controls.
- FR-8: Active plane constraints MUST project source transforms, follow changes to their target parts, and coexist with existing joint anchors and axis locks. A failed solve MUST preserve the previous scene and explain the conflicting relationship.
- FR-9: Native save, recovery, undo, redo, internal component copy, cut, paste, duplication, removal, and merging MUST preserve or clean up plane constraints consistently with their part references.
- FR-10: Help and inline hints MUST describe camera gestures, Shift precision, contiguous paint, plane tolerances, and the degrees of freedom retained by plane relationships.

## Non-Functional Requirements

- NFR-1: All numeric solver inputs MUST be finite; angles MUST stay in 0–180 degrees and plane distances MUST be nonnegative. Failed or degenerate fits MUST report a visible error.
- NFR-2: A geometry's edge adjacency MUST be cached for reuse across brush strokes, and existing BVH brush acceleration MUST remain available.
- NFR-3: New controls MUST have accessible labels and all conflict messages MUST use the existing announced toast or status region.
- NFR-4: A gizmo drag MUST remain one undo step, including when Shift changes mid-drag. Old version-1 scenes without plane constraints MUST load successfully.
- NFR-5: The solver MUST use a bounded iteration count and validate angular and seating residuals before accepting persistent placement.

## Acceptance Criteria

### AC-1: Navigate while collecting surfaces (FR-1)

Given an unfinished point pair or painted patch
When the user orbits with middle-drag or Space + left-drag and pans with right-drag
Then the camera changes while the operation, existing picks, patches, and part transforms remain unchanged
And releasing Space or losing window focus restores normal tool input.

### AC-2: Continuous fine adjustment (FR-2, NFR-4)

Given an active gizmo drag
When Shift is pressed, another raw movement is made, and Shift is released
Then only the movement during Shift has one tenth sensitivity and neither transition changes the effective transform
And undo restores the transform before the whole drag.

### AC-3: Connected scan paint (FR-3, FR-5, NFR-2)

Given indexed or nonindexed adjacent triangles and a separate nearby coplanar shell
When a large brush is applied or a remote subsequent stroke is attempted
Then the patch contains only the connected seeded surface
And erasing a bridge leaves one connected component.

### AC-4: Fixed plane filtering (FR-4, NFR-1)

Given a connected surface with a bend or step
When seed-plane filtering is on and the brush grows across it
Then faces beyond either tolerance are excluded even on later strokes
And disabling the filter permits connected curved patches.

### AC-5: Coarse plane placement (FR-6, NFR-1)

Given one or more complete painted pairs
When mate, parallel, perpendicular, or angle placement is applied
Then the fitted normals meet the selected relationship
And only mate changes the plane-normal separation while retaining in-plane placement freedom.

### AC-6: Persistent relationships and conflicts (FR-7, FR-8, NFR-3, NFR-5)

Given enabled plane constraints and optional existing joints
When source or target transforms or a constraint parameter changes
Then the resulting scene satisfies active anchors, locks, and plane residuals or the entire request is rejected with a conflict message
And suppressing or deleting the constraint restores that freedom.

### AC-7: Durable editable assembly (FR-9, NFR-4)

Given a scene containing plane constraints
When it is saved and reopened, undone and redone, copied, cut, duplicated, deleted, or merged
Then internal constraint IDs and endpoints remain valid and external or removed-part relationships are excluded
And older scenes remain readable.

### AC-8: Discoverable interaction (FR-10, NFR-3)

Given the workbench help or surface alignment controls
When the user reviews the available actions
Then gesture and precision hints, plane tolerances, retained freedom, constraint controls, and validation errors are visible with accessible labels.

## Edge Cases

- EC-1: Degenerate or empty patches and invalid numeric values produce an actionable error without changing the scene.
- EC-2: Disconnected coplanar shells, hard normal bends, small positional scan seams, and large nonindexed meshes use edge connectivity rather than proximity connectivity.
- EC-3: Pointer cancellation, Space release, and window blur end transient navigation or precision state; Alt retains erase behavior.
- EC-4: Cyclic part dependencies are rejected; conflicting plane equations or pinned followers leave the prior scene intact.
- EC-5: File and recovery failures retain existing error handling; malformed constraints are rejected rather than silently discarded.
- EC-6: Hidden parts and nonuniformly scaled parts use the same world-plane math as visible unscaled parts. Locked parts never move during a solve.

## API Contracts

These are local TypeScript APIs; no network service is introduced. HTTP endpoints such as POST /api/constraints are not applicable to this local workbench.

```typescript
interface PlaneFrame {
  point: Vec3;
  normal: Vec3;
}
interface PlaneConstraint {
  id: string;
  name: string;
  sourceId: string;
  targetId: string;
  sourcePlane: PlaneFrame;
  targetPlane: PlaneFrame;
  kind: 'mate' | 'parallel' | 'perpendicular' | 'angle';
  angle: number;
  offset: number;
  opposed: boolean;
  enabled: boolean;
}
interface PlaneSolveResult {
  parts: Part[];
}
// Solvers return validated parts or throw Error with user-readable context.
// Editor actions catch errors and preserve the original scene.
```

## Data Models

| Entity / field                            | Type                           | Constraints                                            |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| SceneDocument.constraints                 | PlaneConstraint[] (optional)   | Defaults to empty for old scenes                       |
| PlaneConstraint.id / name                 | string                         | Unique ID; editable relationship label                 |
| PlaneConstraint.sourceId / targetId       | string                         | Existing distinct parts; acyclic active dependencies   |
| PlaneConstraint.sourcePlane / targetPlane | PlaneFrame                     | Local finite point and unit normal from painted fit    |
| PlaneConstraint.kind                      | enum                           | mate, parallel, perpendicular, angle                   |
| PlaneConstraint.angle / offset            | number                         | Angle in 0–180 degrees; signed offset in mm            |
| PlaneConstraint.opposed / enabled         | boolean                        | Normal direction and suppression state                 |
| SurfacePatch.seed                         | SurfacePoint (optional)        | Fixed local seed reference for plane filter            |
| Brush settings                            | plane enabled, angle, distance | Transient selection preferences; finite bounded inputs |
| Operation plane settings                  | method, angle, retain          | Preserve contact best fit as default                   |
| Transient input                           | temporary orbit, precision     | Never serialized; cleared on blur                      |

## Out of Scope

- OS-1: A complete Fusion sketch, B-rep, or parametric solid-modeling kernel; this increment adds painted plane relationships to the existing mesh workbench.
- OS-2: A general nonlinear solver for cyclic mechanisms; directed part dependencies and bounded projection keep failures explicit.
- OS-3: Reconstructing live plane constraints inside Blender or 3MF; exports retain solved geometry and metadata, while native Kitbasher files retain editable constraints.

## Open Questions

None. The user authorized these editor changes; the implementation contract was checked against that scope before coding.
