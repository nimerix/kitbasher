# Move and rotate controls review

Reviewed and improved on November 12, 2026.

## Scope and coverage

The complete desktop Move/Rotate flow: selecting one or several parts, choosing axes,
setting increments, dragging handles, entering absolute values, stepping with buttons,
and undoing adjustments. Included empty, hidden, locked, joint-constrained, isolated,
and exploded selections. These controls have no independent asynchronous loading state.
Import/recovery loading, other editor workflows, and headset UI are outside this review.

The implementation follows the React, Zustand, Three.js, plain CSS, Inter, and Lucide
conventions in `docs/design.md`, `docs/cad-constraints-spec.md`, and `README.md`.
No applicable AGENTS.md, CONTRIBUTING.md, or CLAUDE.md was found. Existing dark surfaces,
compact density, axis colors, and orange active states are retained.

| Domain        | Evidence inspected                                                                                                            | Result                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accessibility | `TransformAdjustments.tsx`, `ui.tsx`, keyboard activation and focus checks, Chromium accessibility snapshot, group transforms | Added a keyboard and single-click alternative to group dragging; verified names, pressed states, native disabled states, and focus. Manual assistive technology testing remains unverified. |
| Layout        | `App.tsx`, `Inspector.tsx`, `styles.css`; 320, 720, 800, 1100, 1250, 1251, 1440, and 1600px layouts                           | Controls fit; intermediate toolbar widths wrap when required; inspector content scrolls.                                                                                                    |
| Writing       | Axis, pivot, unit, snap, and unavailability labels compared with `transform-selection.ts` and `Viewport.tsx`                  | Actual coordinate systems and increments are stated; restrictions include a recovery action.                                                                                                |
| Typography    | Computed field styles and desktop/mobile screenshots                                                                          | Tabular values retained; transform inputs use 16px on narrow screens.                                                                                                                       |
| Colors        | Computed colors on the dark panel and raised input surfaces; WCAG contrast calculation                                        | New helper text 5.57:1, button text 10.85:1, active text 6.50:1, axis letters at least 5.66:1, input border 3.15:1, focus ring 6.40:1. Disabled controls excluded.                          |
| UI            | Selected, disabled, empty, stepped, dragging, and undo states in `TransformAdjustments.tsx` and `Viewport.tsx`                | Labeled tool choices, instant feedback, explanatory state text, shared transform frame, and retained transform tool after undo. No new motion added.                                        |

## Findings and implemented changes

Locations point to the final implementation of each fix.

| Severity | Domain        | Location                                                                            | Before                                                                                                                                                                   | After                                                                                                                                           | Why                                                                                                                         |
| -------- | ------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| HIGH     | Accessibility | `src/components/TransformAdjustments.tsx:145`; `src/components/Inspector.tsx:948`   | Multiple selected parts could only be transformed together by dragging a handle.                                                                                         | X/Y/Z −/+ buttons apply a precise rigid step to the selection, with native keyboard activation.                                                 | Provides a single-pointer alternative to dragging and a keyboard path for group placement (WCAG 2.5.7 and 2.1.1).           |
| HIGH     | Colors        | `src/styles.css:1777`                                                               | Numeric unit labels used `#687788` on `#202226`, measuring 3.48:1.                                                                                                       | Transform field labels use the existing muted text token, measuring 5.57:1.                                                                     | Small labels require 4.5:1 text contrast.                                                                                   |
| HIGH     | Layout        | `src/styles.css:6312`                                                               | During verification, a populated toolbar put controls past the right edge at intermediate widths, including 1251px and 800px.                                            | Toolbar groups wrap above the mobile breakpoint when needed; narrow layouts retain their existing panel controls.                               | Settings and the inspector toggle remain reachable. Rechecked with both Snap and Avoid clipping enabled.                    |
| MEDIUM   | Writing       | `src/components/TransformAdjustments.tsx:88`; `src/components/Inspector.tsx:220`    | World/Local appeared above numeric fields whose values did not change coordinate system. Connected joints could override the selected axes without a nearby explanation. | Handle/step axes are separate from explicitly labeled absolute fields. Joint axes and group world axes are explained; rotation names its pivot. | Prevents confusing relative adjustments with absolute coordinates.                                                          |
| MEDIUM   | Writing       | `src/App.tsx:480`; `src/components/Viewport.tsx:437`                                | Rotate showed a distance selector while using an undisclosed fixed 15° snap.                                                                                             | The toolbar shows angle for Rotate and distance for Move; custom step values also drive the corresponding handles.                              | The setting describes and controls the active tool.                                                                         |
| MEDIUM   | Writing       | `src/core/transform-selection.ts:59`; `src/components/TransformAdjustments.tsx:179` | Handles could disappear for hidden, locked, pinned, or exploded selections without contextual guidance.                                                                  | Disabled adjustment buttons have nearby selection, lock, navigation, or view guidance. Joint axis locks also disable the corresponding buttons. | Makes restrictions and the next action understandable.                                                                      |
| MEDIUM   | UI            | `src/core/store.ts:1454`; `src/core/store.ts:1478`                                  | Undo and redo always returned to Select, interrupting repeated adjustments.                                                                                              | Move, Rotate, and Scale remain active. Unfinished alignment operations still clear.                                                             | Users can correct a step and continue the same placement task.                                                              |
| MEDIUM   | Typography    | `src/styles.css:1800`                                                               | Transform numeric inputs remained 10px on narrow screens.                                                                                                                | Transform numeric inputs use 16px on narrow screens.                                                                                            | Improves readability and avoids the small-input condition that triggers iOS focus zoom; actual iOS behavior was not tested. |

## Verification

Passed:

- `npm test`: 819 tests passed; the opt-in dense-scan benchmark was skipped.
- `npm run build`: TypeScript, browser build, MCP build, and headset build passed.
- `npm run format:check` and `git diff --check` passed.
- `npx playwright test tests/e2e/transforms.spec.ts tests/e2e/cad-constraints.spec.ts tests/e2e/workbench.spec.ts tests/e2e/shortcuts.spec.ts tests/e2e/anchors.spec.ts`: 39 tests passed.
- The focused transform browser suite was rerun after preserving Scale's axis selector on narrow screens.
- Real pointer drags verified custom 7° rotation snapping, Shift sensitivity including mid-drag changes, interruption recovery, and one undo checkpoint per drag.
- Button and keyboard checks verified local movement, exact steps, cancelled/invalid drafts, joint locks, group rotation, and undo.
- Unit checks verified custom pivots, mirrored/nonuniform scale, unchanged geometry buffers, connected parts moving once, clipping, isolation, and undo/redo tool retention.
- Desktop and narrow render inspection covered the selected part, joint, and group controls. A 720×500 layout was checked as the reflow size corresponding to a 1440×1000 desktop at 200%; it is not an actual browser zoom test. The adjustment block also retained its width under RTL.

Not verified: VoiceOver or other screen readers, actual browser 200% zoom, physical
touch/trackpad interaction, Safari/iOS, headset interaction, and production deployment.
No whole-application accessibility conformance is claimed.

## Verdict

**Approve for the inspected Move/Rotate scope.** The confirmed high-severity findings
are resolved. Manual assistive technology, device-specific interaction, and actual
browser zoom remain verification limits.
