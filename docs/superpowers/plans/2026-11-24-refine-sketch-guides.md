# Refine sketch guides implementation plan

**Goal:** Make an Edge guide the edge itself, with settings that say how far the solve may move it,
and let the user place guide points exactly: on sketch planes, along lines, fixed, by a move
widget, and held by segment constraints.

**Spec:** `docs/superpowers/specs/2026-11-24-refine-sketch-guides-design.md`. Background:
`docs/superpowers/specs/2026-11-19-scan-restoration-design.md`, "How an edge is rebuilt".

**Tech stack:** TypeScript, three.js, react-three-fiber, Zustand, Vitest, Playwright.

## Global constraints

- Today's solve is the Along preset: `position` absent or `along`, `path` absent or false, `fit`
  absent or null (today's reach), `wallAngle` absent or null. Detect's proposals and the crease
  brush never set the new fields, so their inputs and results are unchanged.
- Hand-placed guides take the session's next-guide settings: Corner, Fit 0, Use guide path on,
  Wall angle Automatic, and Use guide plane on when the guide has a plane.
- Every guide point keeps a valid `triangle`: a point off the surface takes the nearest triangle.
- Lengths in mm. Commit subjects `(<type>) <Sentence-case summary>`, no attribution.
- Checks per step: `npx tsc --noEmit`, the step's `npx vitest run tests/unit/refine-...` files,
  `npx playwright test tests/e2e/refine.spec.ts`, `npm run format:check`.

## Step 1: Solve settings

**Files:** `src/core/refine-edge.ts`, `src/core/store.ts`, `src/components/RefineControls.tsx`,
new `tests/unit/refine-guide-edge.test.ts`.

1. `EdgeInput` gains `position`, `fit`, `path`, `wallAngle`, `plane` and `usePlane` (all
   optional). `EdgePosition = 'corner' | 'top' | 'bottom' | 'along'`.
2. In `solvePart`, after `unbiasedFlanks`, a `settle` step turns the scan's flanks into the
   segment's final flanks and edge: tell the surface from the wall, put the sketch plane in as the
   surface (Use guide plane), find where the faces meet, the guide's edge (Corner: the guide; Top
   and Bottom: the guide carried onto the meet by one offset; Along: the guide), move it toward the
   meet by at most Fit (one offset with Use guide path, per point without), and build the wall
   through that edge at the wall angle for a line or arc. Along with no settings is today's
   `fitMeet` exactly.
3. `shareFlanks`, `clearCorners` and `resolveParts` refit the scan's flanks and call `settle`, so a
   shared surface or a cleared corner keeps the guide's edge.
4. A closed single arc fits its circle to the parts' edges, not the meets, when settings are set.
5. A refusal carries a reason the status line names (`EdgeRefusal`).
6. Store: `RefineSession.edge` gains the new defaults; `addRefinePoint` writes them;
   `setRefineEdge` sets them; `solveProposal`'s cache is keyed by the input, so new settings
   invalidate it.
7. Panel: Position (segmented), Fit (mm field), Use guide path and Use guide plane (switches), Wall
   angle (`AutoSetting`).
8. Tests: the design's Verification items for the solve (slot, Top and Bottom on a fillet, Fit,
   Use guide path). Existing tests that place guides by hand and assert today's solve are pinned to
   Along.

## Step 2: Sketch planes and points

**Files:** new `src/core/refine-sketch.ts` (planes, projection, nearest triangle, locks), store,
`RefinePointer.tsx`, `Viewport.tsx`, `RefineOverlay.tsx`, `RefineControls.tsx`,
`EditorContextMenu.tsx`, new `src/components/RefinePointWidget.tsx`.

1. `SketchPlane {id, origin, normal, u, v}`; session `planes`, `edge.plane` (next guide), a
   `picking` state for New plane (3 points, or a face) and for a point menu's second click (line
   lock, Align).
2. Drawing on a plane: a click places the point where the ray meets the plane, also off the part;
   the point takes the nearest triangle.
3. Point locks on `GuidePoint`: `lock?: {kind: 'line', origin, direction} | {kind: 'fixed'}`.
   Dragging follows the plane, the line, or does not start.
4. Move widget on the chosen point: world axes, plane axes and a plane square, or the line; one
   drag is one undo step; Escape restores.
5. Point menu on right-click of a handle: Lock (to a plane, new plane, line, Fixed, Unlock), Align
   (Horizontal, Vertical, then a click), Constrain, Delete, through `EditorContextMenu`.
6. Plane grid drawn round the selected guide.

## Step 3: Constraints

**Files:** new `src/core/refine-constraints.ts`, store, overlay, menu.

1. Damped least-squares solver in the plane's (u, v): weighted least change, the moved point
   weighted heavily, fixed points held; every constraint within 1e-6 mm or the change is refused.
2. Kinds: Parallel, Perpendicular, Collinear, Equal, Tangent, Concentric, Horizontal, Vertical,
   Align (point to point), Fixed.
3. Segment menu (right-click a guide line), point menu Constrain, icons beside segments and points
   (right-click an icon to delete).
4. Every point move, constraint change and plane change runs the solver.

## Step 4: Docs

The Refine page in `src/docs` and an entry at the top of `src/docs/changelog.ts`.
